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
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      ...request,
      headers: this.createHeaders(request.headers, 'application/json'),
    });
    if (!response.ok) throw new Error(await this.responseError(response));
    return await response.json() as T;
  }

  async download(path: string, init: Pick<RequestInit, 'headers' | 'signal'> = {}): Promise<ArrayBuffer> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
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

  private async responseError(response: Response): Promise<string> {
    const body = await response.json().catch(() => undefined) as { message?: string; error?: string } | undefined;
    const detail = body && ('message' in body || 'error' in body) ? body.message ?? body.error : undefined;
    return detail ?? \`dkrypt request failed with HTTP \${response.status}\`;
  }
}
`;
}

function renderPython(routes: string[]): string {
  const routeValues = routes.map((route) => `    ${JSON.stringify(route)},`).join('\n');
  return `from __future__ import annotations\n\nimport json\nfrom dataclasses import dataclass\nfrom urllib.error import HTTPError\nfrom urllib.request import Request, urlopen\n\nROUTES = (\n${routeValues}\n)\n\n@dataclass\nclass DkryptClient:\n    base_url: str\n    api_key: str | None = None\n\n    def request(self, method: str, path: str, body: object | None = None) -> object:\n        payload = None if body is None else json.dumps(body).encode(\"utf-8\")\n        response = self._send(method, path, payload, \"application/json\")\n        return json.loads(response.decode(\"utf-8\"))\n\n    def download(self, path: str) -> bytes:\n        return self._send(\"GET\", path, None, \"application/octet-stream\")\n\n    def _send(self, method: str, path: str, payload: bytes | None, accept: str) -> bytes:\n        headers = {\"Accept\": accept}\n        if self.api_key:\n            headers[\"Authorization\"] = f\"Bearer {self.api_key}\"\n        if payload is not None:\n            headers[\"Content-Type\"] = \"application/json\"\n        request = Request(self.base_url.rstrip(\"/\") + path, data=payload, headers=headers, method=method.upper())\n        try:\n            with urlopen(request) as response:\n                return response.read()\n        except HTTPError as error:\n            detail = error.read().decode(\"utf-8\", errors=\"replace\")\n            raise RuntimeError(f\"dkrypt request failed with HTTP {error.code}: {detail}\") from error\n`;
}
