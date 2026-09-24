import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifySchema } from 'fastify';
import { getRouteContract } from '#contracts.js';
import { withCorrelation } from '#correlation.js';
import type { Session } from '#session.js';

export interface RequestLocals {
  session: Session;
  apiKeyScope?: string[];
  apiKeyOwner?: string;
  apiKeyPriority?: number;
  apiKeyId?: string;
  apiKeyAllowTestFlight?: boolean;
}

export type Request = FastifyRequest & {
  body: Record<string, unknown>;
  params: Record<string, string>;
  query: Record<string, unknown>;
  header(name: string): string | undefined;
  path: string;
  on(event: string, listener: () => void): void;
};

export class Response {
  readonly locals: RequestLocals = {} as RequestLocals;

  constructor(readonly reply: FastifyReply) {}

  get raw() {
    return this.reply.raw;
  }

  get headersSent(): boolean {
    return this.reply.sent || this.raw.headersSent;
  }

  status(code: number): this {
    this.reply.code(code);
    return this;
  }

  json(payload: unknown): this {
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as { error?: unknown }).error === 'string' && !('code' in payload) && !('requestId' in payload)) {
      const status = this.reply.statusCode;
      const message = (payload as { error: string }).error;
      this.reply.send({ error: message, code: status >= 500 ? 'internal_error' : 'request_error', message, requestId: this.requestId(), retryable: status >= 500 || status === 429 || status === 503 });
      return this;
    }
    this.reply.send(payload);
    return this;
  }

  requestId(): string {
    const value = this.reply.getHeader('X-Request-ID');
    return typeof value === 'string' ? value : this.reply.request.id;
  }

  error(code: string, message: string, status = 400, retryable = false, remediation?: Record<string, unknown>): this {
    this.reply.code(status).send({ error: message, code, message, requestId: this.requestId(), retryable, ...(remediation ? { remediation } : {}) });
    return this;
  }

  send(payload: unknown): this {
    this.reply.send(payload);
    return this;
  }

  setHeader(name: string, value: string): this {
    this.reply.header(name, value);
    this.raw.setHeader(name, value);
    return this;
  }

  set(name: string, value: string): this {
    return this.setHeader(name, value);
  }

  type(value: string): this {
    this.reply.type(value);
    return this;
  }

  redirect(url: string): this {
    this.reply.redirect(url);
    return this;
  }

  download(filePath: string, filename: string): this {
    this.reply.header('Content-Disposition', `attachment; filename="${filename}"`).send(createReadStream(filePath));
    return this;
  }

  flushHeaders(): void {
    this.reply.hijack();
    this.raw.flushHeaders();
  }

  write(chunk: string): void {
    this.reply.hijack();
    this.raw.write(chunk);
  }
}

export type NextFunction = () => void;
export type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

interface Route {
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
  path: string;
  handlers: Handler[];
}

export class HttpRouter {
  readonly middleware: Handler[] = [];
  readonly routes: Route[] = [];

  use(handler: Handler): void {
    this.middleware.push(handler);
  }

  get(path: string, ...handlers: Handler[]): void {
    this.routes.push({ method: 'GET', path, handlers });
  }

  post(path: string, ...handlers: Handler[]): void {
    this.routes.push({ method: 'POST', path, handlers });
  }

  put(path: string, ...handlers: Handler[]): void {
    this.routes.push({ method: 'PUT', path, handlers });
  }

  patch(path: string, ...handlers: Handler[]): void {
    this.routes.push({ method: 'PATCH', path, handlers });
  }

  delete(path: string, ...handlers: Handler[]): void {
    this.routes.push({ method: 'DELETE', path, handlers });
  }
}

export function Router(): HttpRouter {
  return new HttpRouter();
}

function adaptRequest(request: FastifyRequest): Request {
  const req = request as Request;
  req.header = (name) => request.headers[name.toLowerCase()] as string | undefined;
  req.path = new URL(request.raw.url ?? '/', 'http://localhost').pathname;
  req.on = request.raw.on.bind(request.raw);
  return req;
}

async function runHandlers(handlers: Handler[], req: Request, res: Response, index = 0): Promise<void> {
  const handler = handlers[index];
  if (!handler || res.headersSent) return;
  let nextPromise: Promise<void> | undefined;
  const next = () => {
    nextPromise ??= runHandlers(handlers, req, res, index + 1);
  };
  await handler(req, res, next);
  await nextPromise;
}

export function registerRouter(server: FastifyInstance, router: HttpRouter): void {
  for (const route of router.routes) {
    server.route({
      method: route.method,
      url: route.path,
      schema: getRouteContract(route.method, route.path) as FastifySchema | undefined,
      handler: async (request, reply) => {
        const traceContext = (request as unknown as { traceSpan?: { context?: import('#telemetry.js').TraceContext } }).traceSpan?.context;
        await withCorrelation({ correlationId: request.id, traceId: traceContext?.traceId, traceContext }, () => runHandlers([...router.middleware, ...route.handlers], adaptRequest(request), new Response(reply)));
      },
    });
  }
}
