import type { NextFunction, Request, Response } from '#http.js';
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import { recordApiKeyOutcome, verifyApiKey, type ApiKeyAuthResult } from '#store/state.js';

const fastifyApiKeyContext = new WeakMap<FastifyRequest, ApiKeyAuthResult>();

export function getFastifyApiKeyContext(request: FastifyRequest): ApiKeyAuthResult | undefined {
  return fastifyApiKeyContext.get(request);
}

function trackApiKeyOutcome(req: Request, res: Response, keyId: string | undefined): void {
  if (!keyId) return;
  res.raw.once('finish', () => recordApiKeyOutcome(keyId, req.method, req.path ?? req.url.split('?')[0], res.raw.statusCode));
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  const result = scheme === 'Bearer' && token ? verifyApiKey(token, req.ip) : undefined;
  if (result === 'rate-limited') {
    res.error('api_key_rate_limited', 'this API key has hit its daily request limit', 429, true);
    return;
  }
  if (!result) {
    res.error('unauthorized', 'unauthorized', 401, false);
    return;
  }

  res.locals.apiKeyScope = result.allowedBundleIds;
  res.locals.apiKeyOwner = result.ownerId;
  res.locals.apiKeyPriority = result.priority ?? 0;
  res.locals.apiKeyId = result.keyId;
  res.locals.apiKeyAllowTestFlight = result.allowTestFlight ?? true;
  trackApiKeyOutcome(req, res, result.keyId);
  next();
}

export function fastifyRequireApiKey(request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void {
  const header = request.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  const result = scheme === 'Bearer' && token ? verifyApiKey(token, request.ip) : undefined;
  if (result === 'rate-limited') {
    reply.code(429).send({
      error: 'this API key has hit its daily request limit',
      code: 'api_key_rate_limited',
      message: 'this API key has hit its daily request limit',
      requestId: request.id,
      retryable: true,
    });
    return;
  }
  if (!result) {
    reply.code(401).send({ error: 'unauthorized', code: 'unauthorized', message: 'unauthorized', requestId: request.id, retryable: false });
    return;
  }
  fastifyApiKeyContext.set(request, result);
  const keyId = result.keyId;
  if (keyId) {
    reply.raw.once('finish', () => recordApiKeyOutcome(keyId, request.method, request.routeOptions.url ?? request.url.split('?')[0], reply.raw.statusCode));
  }
  done();
}

export function fastifyRequireTestFlightScope(request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void {
  const apiKey = getFastifyApiKeyContext(request);
  if (!apiKey) {
    reply.code(401).send({ error: 'unauthorized', code: 'unauthorized', message: 'unauthorized', requestId: request.id, retryable: false });
    return;
  }
  if (apiKey.allowTestFlight === false) {
    reply.code(403).send({
      error: 'this API key is not scoped for TestFlight',
      code: 'testflight_scope_denied',
      message: 'this API key is not scoped for TestFlight',
      requestId: request.id,
      retryable: false,
    });
    return;
  }
  done();
}

export function requireTestFlightScope(_req: Request, res: Response, next: NextFunction): void {
  if (res.locals.apiKeyAllowTestFlight === false) {
    res.error('testflight_scope_denied', 'this API key is not scoped for TestFlight', 403, false);
    return;
  }
  next();
}
