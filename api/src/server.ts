import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import scalarApiReference from '@scalar/fastify-api-reference';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '#config.js';
import { registerRouter } from '#http.js';
import { startJobSweeper } from '#jobs/store.js';
import { startJobWebhookDispatcher } from '#jobWebhook.js';
import { startKeyExpiryPoller } from '#keyExpiryPoller.js';
import { log, startLogFlusher } from '#logger.js';
import { openApiDocument } from '#openapi.js';
import { authRouter } from '#routes/auth.js';
import { billingRouter, paddleWebhookRouter } from '#routes/billing.js';
import { dashboardRouter } from '#routes/dashboard.js';
import { decryptRouter } from '#routes/decrypt.js';
import { healthRouter } from '#routes/health.js';
import { startScheduler } from '#scheduler/index.js';
import { startApiKeySweeper, startSessionSweeper, startStateFlusher } from '#store/state.js';
import { startDeviceHealthPoller } from '#deviceHealth.js';
import { renderPublicPage } from '#publicPages.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({ bodyLimit: 5 * 1024 * 1024, trustProxy: 'loopback' });

  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    if (request.url.startsWith('/v1/paddle/webhook')) return done(null, body);
    try {
      done(null, body.length === 0 ? {} : JSON.parse(body.toString('utf8')));
    } catch (error) {
      done(error as Error);
    }
  });

  await server.register(fastifyStatic, { root: publicDir, prefix: '/assets/', maxAge: '1y', immutable: true });
  await server.register(scalarApiReference, {
    routePrefix: '/reference',
    configuration: { content: openApiDocument, theme: 'moon' },
  });

  server.addHook('onSend', (request, reply, payload, done) => {
    if (!request.url.startsWith('/assets/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    done(null, payload);
  });

  server.get('/openapi.json', () => openApiDocument);

  const ogImageVersion = createHash('sha256').update(readFileSync(path.join(publicDir, 'og-image.png'))).digest('hex').slice(0, 10);
  const indexHtml = readFileSync(path.join(publicDir, 'index.html'), 'utf8')
    .replaceAll('__PUBLIC_BASE_URL__', config.publicBaseUrl)
    .replaceAll('__OG_IMAGE_VERSION__', ogImageVersion);

  for (const route of ['/', '/pricing', '/terms', '/privacy', '/refund-policy', '/contact']) {
    server.get(route, (request, reply) => reply.type('text/html').send(renderPublicPage(indexHtml, request.url)));
  }

  server.get('/favicon.svg', (_request, reply) => reply.header('Cache-Control', 'public, max-age=86400').type('image/svg+xml').sendFile('favicon.svg'));
  server.get('/favicon.png', (_request, reply) => reply.header('Cache-Control', 'public, max-age=86400').type('image/png').sendFile('favicon.png'));
  server.get('/og-image.png', (_request, reply) => reply.header('Cache-Control', 'public, max-age=86400').type('image/png').sendFile('og-image.png'));
  server.get('/manifest.webmanifest', (_request, reply) =>
    reply.header('Cache-Control', 'public, max-age=86400').type('application/manifest+json').sendFile('manifest.webmanifest'),
  );
  server.get('/.well-known/apple-developer-merchantid-domain-association', (_request, reply) =>
    reply.type('text/plain').sendFile('.well-known/apple-developer-merchantid-domain-association'),
  );
  server.get('/sw.js', (_request, reply) => reply.type('application/javascript').sendFile('sw.js'));

  registerRouter(server, paddleWebhookRouter);
  registerRouter(server, healthRouter);
  registerRouter(server, decryptRouter);
  registerRouter(server, authRouter);
  registerRouter(server, billingRouter);
  registerRouter(server, dashboardRouter);

  server.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not found' }));

  return server;
}

function startBackgroundServices(): void {
  startJobSweeper();
  startStateFlusher();
  startLogFlusher();
  startApiKeySweeper();
  startSessionSweeper();
  startScheduler();
  startDeviceHealthPoller();
  startKeyExpiryPoller();
  startJobWebhookDispatcher();
}

async function start(): Promise<void> {
  const server = await buildServer();
  startBackgroundServices();
  await server.listen({ port: config.port, host: config.bindHost });
  log.info(`dkrypt listening on ${config.bindHost}:${config.port}`);
}

if (import.meta.main) void start();
