import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { config } from '#config.js';
import { buildServer as buildProductionServer } from '#server.js';

type BuildServerOptions = Parameters<typeof buildProductionServer>[0];
type AsyncInjector = (options: InjectOptions | string) => Promise<LightMyRequestResponse>;

function headerValue(headers: InjectOptions['headers'], name: string): string | string[] | undefined {
  const key = Object.keys(headers ?? {}).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers?.[key] as string | string[] | undefined : undefined;
}

function isCookieMutation(options: InjectOptions): boolean {
  const method = String(options.method ?? 'GET').toUpperCase();
  const cookie = headerValue(options.headers, 'cookie');
  const hasCookie = typeof cookie === 'string' ? cookie.length > 0 : Array.isArray(cookie) && cookie.some((value) => value.length > 0);
  const hasOrigin = headerValue(options.headers, 'origin') !== undefined;
  const hasFetchSite = headerValue(options.headers, 'sec-fetch-site') !== undefined;
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && hasCookie && !hasOrigin && !hasFetchSite;
}

export async function buildTestServer(options?: BuildServerOptions) {
  const server = await buildProductionServer(options);
  const originalInject = server.inject.bind(server) as AsyncInjector;
  const injectWithBrowserMetadata: AsyncInjector = (options) => {
    if (typeof options === 'string' || !isCookieMutation(options)) return originalInject(options);
    return originalInject({
      ...options,
      headers: {
        ...options.headers,
        origin: config.publicBaseUrl,
        'sec-fetch-site': 'same-origin',
      },
    });
  };
  server.inject = injectWithBrowserMetadata as FastifyInstance['inject'];
  return server;
}
