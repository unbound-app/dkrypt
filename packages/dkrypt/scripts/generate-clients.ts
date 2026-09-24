import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const stateDir = mkdtempSync(path.join('/tmp', 'dkrypt-client-generation-'));
process.env.API_KEY ??= 'client-generation-api-key';
process.env.SESSION_SIGNING_SECRET ??= 'client-generation-session-secret';
process.env.ADMIN_PASSWORD ??= 'client-generation-admin-password';
process.env.STATE_DIR = stateDir;
process.env.OUTPUT_DIR = path.join(stateDir, 'tmp');
process.env.ARTIFACT_DIR = path.join(stateDir, 'artifacts');

const { buildServer } = await import('../src/server.ts');
const server = await buildServer({ includePublicRoutes: false });
await server.ready();
const document = server.swagger() as { paths?: Record<string, Record<string, unknown>> };
const routes = Object.entries(document.paths ?? {}).flatMap(([route, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${route}`)).sort();
const outputDirectory = path.resolve(process.cwd(), 'clients');
mkdirSync(path.join(outputDirectory, 'typescript'), { recursive: true });
mkdirSync(path.join(outputDirectory, 'python'), { recursive: true });
writeFileSync(path.join(outputDirectory, 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`);
writeFileSync(path.join(outputDirectory, 'typescript', 'dkrypt.ts'), renderTypeScript(routes));
writeFileSync(path.join(outputDirectory, 'python', 'dkrypt_client.py'), renderPython(routes));
await server.close();

function renderTypeScript(routes: string[]): string {
  const routeUnion = routes.map((route) => `  | ${JSON.stringify(route)}`).join('\n');
  return `export type DkryptRoute =\n${routeUnion};\n\nexport interface DkryptRequestInit extends RequestInit {\n  path: string;\n}\n\nexport class DkryptClient {\n  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}\n\n  async request<T>(init: DkryptRequestInit): Promise<T> {\n    const { path, ...request } = init;\n    const response = await this.fetchImpl(new URL(path, this.baseUrl), request);\n    const body = (await response.json()) as T | { message?: string; error?: string };\n    if (!response.ok) {\n      const detail = typeof body === 'object' && body !== null && ('message' in body || 'error' in body) ? body.message ?? body.error : undefined;\n      throw new Error(detail ?? \`dkrypt request failed with HTTP \${response.status}\`);\n    }\n    return body as T;\n  }\n}\n`;
}

function renderPython(routes: string[]): string {
  const routeValues = routes.map((route) => `    ${JSON.stringify(route)},`).join('\n');
  return `from __future__ import annotations\n\nimport json\nfrom dataclasses import dataclass\nfrom urllib.error import HTTPError\nfrom urllib.request import Request, urlopen\n\nROUTES = (\n${routeValues}\n)\n\n@dataclass\nclass DkryptClient:\n    base_url: str\n    api_key: str | None = None\n\n    def request(self, method: str, path: str, body: object | None = None) -> object:\n        headers = {\"Accept\": \"application/json\"}\n        if self.api_key:\n            headers[\"Authorization\"] = f\"Bearer {self.api_key}\"\n        payload = None if body is None else json.dumps(body).encode(\"utf-8\")\n        if payload is not None:\n            headers[\"Content-Type\"] = \"application/json\"\n        request = Request(self.base_url.rstrip(\"/\") + path, data=payload, headers=headers, method=method.upper())\n        try:\n            with urlopen(request) as response:\n                return json.loads(response.read().decode(\"utf-8\"))\n        except HTTPError as error:\n            detail = error.read().decode(\"utf-8\", errors=\"replace\")\n            raise RuntimeError(f\"dkrypt request failed with HTTP {error.code}: {detail}\") from error\n`;
}
