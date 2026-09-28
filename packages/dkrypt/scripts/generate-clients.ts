import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { preserveOpenApiPathOrder } from './openapiPathOrder.js';

const stateDir = mkdtempSync(path.join('/tmp', 'dkrypt-client-generation-'));
process.env.API_KEY ??= 'client-generation-api-key';
process.env.SESSION_SIGNING_SECRET ??= 'client-generation-session-secret';
process.env.ADMIN_PASSWORD ??= 'client-generation-admin-password';
process.env.STATE_DIR = stateDir;
process.env.OUTPUT_DIR = path.join(stateDir, 'tmp');
process.env.ARTIFACT_DIR = path.join(stateDir, 'artifacts');

const { buildServer } = await import('../src/server.ts');
const { createPublicOpenApiDocument } = await import('../src/publicApi.ts');
const server = await buildServer({ includePublicRoutes: false });
await server.ready();
const document = createPublicOpenApiDocument(server.swagger());
const openApiPath = path.resolve(process.cwd(), 'clients', 'openapi.json');
if (existsSync(openApiPath)) {
  const previousDocument = JSON.parse(readFileSync(openApiPath, 'utf8')) as { paths?: Record<string, Record<string, unknown>> };
  document.paths = preserveOpenApiPathOrder(previousDocument.paths ?? {}, document.paths ?? {});
}
const routes = Object.entries(document.paths ?? {}).flatMap(([route, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${route}`)).sort();
const outputDirectory = path.resolve(process.cwd(), 'clients');
mkdirSync(path.join(outputDirectory, 'typescript'), { recursive: true });
mkdirSync(path.join(outputDirectory, 'python'), { recursive: true });
writeFileSync(openApiPath, `${JSON.stringify(document, null, 2)}\n`);
writeFileSync(path.join(outputDirectory, 'typescript', 'dkrypt.ts'), renderTypeScript(routes));
writeFileSync(path.join(outputDirectory, 'python', 'dkrypt_client.py'), renderPython(routes));
await server.close();

function renderTypeScript(routes: string[]): string {
  const routeUnion = routes.map((route) => `  | ${JSON.stringify(route)}`).join('\n');
  return `export type DkryptRoute =
${routeUnion};

export interface DkryptClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface DkryptRequestInit extends RequestInit {
  path: string;
}

export class DkryptClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, options?: DkryptClientOptions);
  constructor(baseUrl: string, fetchImpl?: typeof fetch);
  constructor(baseUrl: string, optionsOrFetch: DkryptClientOptions | typeof fetch = {}) {
    const options = typeof optionsOrFetch === 'function' ? { fetchImpl: optionsOrFetch } : optionsOrFetch;
    this.baseUrl = baseUrl;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T>(init: DkryptRequestInit): Promise<T> {
    const { path, ...request } = init;
    const response = await this.fetchImpl(this.buildUrl(path), {
      ...request,
      headers: this.createHeaders(request.headers, 'application/json'),
    });
    if (!response.ok) throw new Error(await this.responseError(response));
    return await response.json() as T;
  }

  async download(path: string, init: Pick<RequestInit, 'headers' | 'signal'> = {}): Promise<ArrayBuffer> {
    const response = await this.fetchImpl(this.buildUrl(path), {
      ...init,
      method: 'GET',
      headers: this.createHeaders(init.headers, 'application/octet-stream'),
    });
    if (!response.ok) throw new Error(await this.responseError(response));
    return response.arrayBuffer();
  }

  private createHeaders(headers: RequestInit['headers'] | undefined, accept: string): Headers {
    const result = new Headers(headers);
    if (this.apiKey && !result.has('authorization')) result.set('Authorization', \`Bearer \${this.apiKey}\`);
    if (!result.has('accept')) result.set('Accept', accept);
    return result;
  }

  private buildUrl(path: string): URL {
    const baseUrl = new URL(this.baseUrl);
    const url = new URL(path, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== baseUrl.origin) {
      throw new Error('dkrypt requests must use the configured origin');
    }
    return url;
  }

  private async responseError(response: Response): Promise<string> {
    const body: unknown = await response.json().catch(() => undefined);
    let detail: string | undefined;
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      const errorBody = body as Record<string, unknown>;
      if (typeof errorBody.message === 'string') detail = errorBody.message;
      else if (typeof errorBody.error === 'string') detail = errorBody.error;
    }
    return detail ?? \`dkrypt request failed with HTTP \${response.status}\`;
  }
}
`;
}

function renderPython(routes: string[]): string {
  const routeValues = routes.map((route) => `    ${JSON.stringify(route)},`).join('\n');
  return `from __future__ import annotations

import json
from dataclasses import dataclass
from urllib.error import HTTPError
from urllib.parse import SplitResult, urljoin, urlsplit
from urllib.request import Request, urlopen

ROUTES = (
${routeValues}
)

@dataclass
class DkryptClient:
    base_url: str
    api_key: str | None = None

    def request(self, method: str, path: str, body: object | None = None) -> object:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        response = self._send(method, path, payload, "application/json")
        return json.loads(response.decode("utf-8"))

    def download(self, path: str) -> bytes:
        return self._send("GET", path, None, "application/octet-stream")

    def _send(self, method: str, path: str, payload: bytes | None, accept: str) -> bytes:
        headers = {"Accept": accept}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self._build_url(path), data=payload, headers=headers, method=method.upper())
        if self.api_key:
            request.add_unredirected_header("Authorization", f"Bearer {self.api_key}")
        try:
            with urlopen(request) as response:
                return response.read()
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"dkrypt request failed with HTTP {error.code}: {detail}") from error

    def _build_url(self, path: str) -> str:
        base_url = self.base_url.rstrip("/") + "/"
        request_url = urljoin(base_url, path)
        base = urlsplit(base_url)
        target = urlsplit(request_url)
        if (
            target.scheme.lower() not in ("http", "https")
            or target.username is not None
            or target.password is not None
            or self._origin(base) != self._origin(target)
        ):
            raise ValueError("dkrypt requests must use the configured origin")
        return request_url

    @staticmethod
    def _origin(url: SplitResult) -> tuple[str, str | None, int]:
        scheme = url.scheme.lower()
        default_port = 443 if scheme == "https" else 80
        port = url.port
        return scheme, url.hostname, default_port if port is None else port
`;
}
