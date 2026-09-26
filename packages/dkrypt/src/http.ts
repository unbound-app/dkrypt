import { createReadStream } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
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

}

export type NextFunction = () => void;
