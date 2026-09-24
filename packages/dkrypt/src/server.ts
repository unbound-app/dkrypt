import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import scalarApiReference from '@scalar/fastify-api-reference';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '#config.js';
import { registerRouter } from '#http.js';
import { getArtifactBackedJobs, shutdownJobs, startJobSweeper } from '#jobs/store.js';
import { startJobWebhookDispatcher } from '#jobWebhook.js';
import { startKeyExpiryPoller } from '#keyExpiryPoller.js';
import { log, startLogFlusher } from '#logger.js';
import { authRouter } from '#routes/auth.js';
import { billingRouter, nowpaymentsWebhookRouter, stripeWebhookRouter } from '#routes/billing.js';
import { dashboardRouter } from '#routes/dashboard.js';
import { decryptRouter } from '#routes/decrypt.js';
import { healthRouter } from '#routes/health.js';
import { startScheduler } from '#scheduler/index.js';
import { closeStateDatabase, startApiKeySweeper, startSessionSweeper, startStateFlusher } from '#store/state.js';
import { startDeviceHealthPoller } from '#deviceHealth.js';
import { renderPublicPage } from '#publicPages.js';
import { startNotificationDigestScheduler } from '#notify.js';
import { closeArtifactDatabase, initializeArtifactStore } from '#artifacts.js';
import { startTestFlightSubscriptionPoller } from '#testflightSubscriptions.js';
import { startCryptoBillingPoller } from '#cryptoBilling.js';
import { closeBillingDatabase } from '#billing.js';
import { closeIdentityDatabase } from '#identity.js';
import { closeIdempotencyDatabase } from '#idempotency.js';
import { closeWebhookInboxDatabase } from '#webhookInbox.js';
import { incrementMetric, observeMetric } from '#metrics.js';
import { startSpan, startTelemetry, stopTelemetry, traceContextFromHeader, type SpanHandle } from '#telemetry.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export async function buildServer(options: { includePublicRoutes?: boolean } = {}): Promise<FastifyInstance> {
  const server = Fastify({ bodyLimit: 5 * 1024 * 1024, trustProxy: 'loopback' }).withTypeProvider<TypeBoxTypeProvider>();

  await server.register(fastifySwagger, {
    mode: 'dynamic',
    openapi: {
      openapi: '3.1.0',
      info: { title: 'dkrypt API', version: '1.0.0', description: 'Typed API for dkrypt device operations, decrypt jobs, artifacts, billing, and administration.' },
      servers: [{ url: '/' }],
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearerAuth: [] }],
    },
  });

  server.addHook('onRequest', (request, reply, done) => {
    (request as unknown as { metricsStartedAt: number }).metricsStartedAt = performance.now();
    const supplied = request.headers['x-request-id'];
    const requestId = typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
    (request as unknown as { id: string }).id = requestId;
    reply.header('X-Request-ID', requestId);
    const traceparent = typeof request.headers.traceparent === 'string' ? request.headers.traceparent : undefined;
    const trace = startSpan('http.request', { 'http.method': request.method, 'http.request_id': requestId }, traceparent ? traceContextFromHeader(traceparent) : undefined);
    (request as unknown as { traceSpan: SpanHandle }).traceSpan = trace;
    reply.header('traceparent', trace.context.traceparent);
    const method = request.method.toUpperCase();
    const isMutation = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    const isWebhook = request.url.startsWith('/v1/stripe/webhook') || request.url.startsWith('/v1/nowpayments/webhook');
    const hasCookie = typeof request.headers.cookie === 'string' && request.headers.cookie.length > 0;
    if (isMutation && !isWebhook && hasCookie) {
      const fetchSite = request.headers['sec-fetch-site'];
      if (fetchSite === 'cross-site') {
        reply.code(403).send({ error: 'cross-site mutation rejected', code: 'csrf_origin_rejected', message: 'cross-site mutation rejected', requestId, retryable: false });
        return;
      }
      const origin = request.headers.origin;
      if (typeof origin === 'string') {
        try {
          if (new URL(origin).origin !== new URL(config.publicBaseUrl).origin) {
            reply.code(403).send({ error: 'request origin is not allowed', code: 'csrf_origin_rejected', message: 'request origin is not allowed', requestId, retryable: false });
            return;
          }
        } catch {
          reply.code(403).send({ error: 'request origin is not allowed', code: 'csrf_origin_rejected', message: 'request origin is not allowed', requestId, retryable: false });
          return;
        }
      }
    }
    done();
  });

  server.addHook('onResponse', (request, reply, done) => {
    incrementMetric('http_requests_total', { method: request.method, path: request.routeOptions.url ?? request.url.split('?')[0], status: reply.statusCode });
    const startedAt = (request as unknown as { metricsStartedAt?: number }).metricsStartedAt;
    if (startedAt !== undefined) observeMetric('http_request_duration_ms', performance.now() - startedAt);
    const trace = (request as unknown as { traceSpan?: SpanHandle }).traceSpan;
    trace?.setAttributes({ 'http.route': request.routeOptions.url ?? request.url.split('?')[0], 'http.status_code': reply.statusCode });
    trace?.end(reply.statusCode >= 500 ? new Error(`HTTP ${reply.statusCode}`) : undefined);
    done();
  });

  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    if (request.url.startsWith('/v1/stripe/webhook') || request.url.startsWith('/v1/nowpayments/webhook')) return done(null, body);
    try {
      done(null, body.length === 0 ? {} : JSON.parse(body.toString('utf8')));
    } catch (error) {
      done(error as Error);
    }
  });

  if (options.includePublicRoutes !== false) {
    await server.register(fastifyStatic, { root: path.join(publicDir, 'assets'), prefix: '/assets/', maxAge: '1y', immutable: true });
    await server.register(scalarApiReference, {
      routePrefix: '/reference',
      configuration: { url: '/openapi.json', theme: 'moon' },
    });
  }

  server.addHook('onSend', (request, reply, payload, done) => {
    if (!request.url.startsWith('/assets/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=()');
    reply.header('Content-Security-Policy', "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:");
    if (config.publicBaseUrl.startsWith('https://')) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    done(null, payload);
  });

  server.get('/openapi.json', (_request, reply) => reply.send(server.swagger()));

  if (options.includePublicRoutes !== false) {
    const ogImageVersion = createHash('sha256').update(readFileSync(path.join(publicDir, 'og-image.png'))).digest('hex').slice(0, 10);
    const indexHtml = readFileSync(path.join(publicDir, 'index.html'), 'utf8')
      .replaceAll('__PUBLIC_BASE_URL__', config.publicBaseUrl)
      .replaceAll('__OG_IMAGE_VERSION__', ogImageVersion);

    for (const route of ['/', '/pricing', '/terms', '/privacy', '/refund-policy', '/contact']) {
      server.get(route, (request, reply) => reply.type('text/html').send(renderPublicPage(indexHtml, request.url)));
    }

    server.get('/favicon.svg', (_request, reply) => reply.header('Cache-Control', 'public, max-age=86400').type('image/svg+xml').sendFile('favicon.svg', publicDir));
    server.get('/favicon.png', (_request, reply) => reply.header('Cache-Control', 'public, max-age=86400').type('image/png').sendFile('favicon.png', publicDir));
    server.get('/og-image.png', (_request, reply) => reply.header('Cache-Control', 'public, max-age=86400').type('image/png').sendFile('og-image.png', publicDir));
    server.get('/manifest.webmanifest', (_request, reply) =>
      reply.header('Cache-Control', 'public, max-age=86400').type('application/manifest+json').sendFile('manifest.webmanifest', publicDir),
    );
    server.get('/.well-known/apple-developer-merchantid-domain-association', (_request, reply) =>
      reply.type('text/plain').sendFile('.well-known/apple-developer-merchantid-domain-association', publicDir),
    );
    server.get('/sw.js', (_request, reply) => reply.type('application/javascript').sendFile('sw.js', publicDir));
  }

  registerRouter(server, stripeWebhookRouter);
  registerRouter(server, nowpaymentsWebhookRouter);
  registerRouter(server, healthRouter);
  registerRouter(server, decryptRouter);
  registerRouter(server, authRouter);
  registerRouter(server, billingRouter);
  registerRouter(server, dashboardRouter);

  server.setNotFoundHandler((request, reply) => reply.code(404).send({ error: 'not found', code: 'not_found', message: 'not found', requestId: request.id, retryable: false }));
  server.setErrorHandler((error, request, reply) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500;
    const status = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    log.error('unhandled request error', { requestId: request.id, method: request.method, path: request.url, error: normalized.message });
    reply.code(status).send({ error: status >= 500 ? 'internal server error' : normalized.message, code: status >= 500 ? 'internal_error' : 'request_error', message: status >= 500 ? 'internal server error' : normalized.message, requestId: request.id, retryable: status >= 500 });
  });

  return server;
}

async function startBackgroundServices(): Promise<void> {
  startTelemetry();
  await initializeArtifactStore(getArtifactBackedJobs());
  startJobSweeper();
  startStateFlusher();
  startLogFlusher();
  startApiKeySweeper();
  startSessionSweeper();
  startScheduler();
  startDeviceHealthPoller();
  startKeyExpiryPoller();
  startTestFlightSubscriptionPoller();
  startCryptoBillingPoller();
  startJobWebhookDispatcher();
  startNotificationDigestScheduler();
}

async function start(): Promise<void> {
  const server = await buildServer();
  await startBackgroundServices();
  await server.listen({ port: config.port, host: config.bindHost });
  log.info(`dkrypt listening on ${config.bindHost}:${config.port}`);
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('graceful shutdown started', { signal });
    await shutdownJobs();
    await server.close();
    closeBillingDatabase();
    closeIdentityDatabase();
    closeIdempotencyDatabase();
    closeWebhookInboxDatabase();
    closeArtifactDatabase();
    closeStateDatabase();
    await stopTelemetry();
    log.info('graceful shutdown completed', { signal });
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

if (import.meta.main) void start();
