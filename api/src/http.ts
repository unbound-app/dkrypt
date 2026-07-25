import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type Request = FastifyRequest & {
  body: any;
  params: any;
  query: any;
  header(name: string): string | undefined;
  path: string;
  on(event: string, listener: () => void): void;
};

export class Response {
  readonly locals: any = {};

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
    this.reply.send(payload);
    return this;
  }

  send(payload: unknown): this {
    this.reply.send(payload);
    return this;
  }

  setHeader(name: string, value: string): this {
    this.reply.header(name, value);
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
      handler: async (request, reply) => {
        await runHandlers([...router.middleware, ...route.handlers], adaptRequest(request), new Response(reply));
      },
    });
  }
}
