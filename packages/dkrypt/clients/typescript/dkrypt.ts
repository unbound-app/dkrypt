export type DkryptRoute =
  | "GET /v1/artifacts"
  | "GET /v1/artifacts/{id}"
  | "GET /v1/artifacts/{id}/file"
  | "GET /v1/decrypt"
  | "GET /v1/jobs/{id}"
  | "POST /v1/decrypts"
  | "POST /v1/testflight/decrypt";

export interface DkryptRequestInit extends RequestInit {
  path: string;
}

export class DkryptClient {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async request<T>(init: DkryptRequestInit): Promise<T> {
    const { path, ...request } = init;
    const response = await this.fetchImpl(new URL(path, this.baseUrl), request);
    const body = (await response.json()) as T | { message?: string; error?: string };
    if (!response.ok) {
      const detail = typeof body === 'object' && body !== null && ('message' in body || 'error' in body) ? body.message ?? body.error : undefined;
      throw new Error(detail ?? `dkrypt request failed with HTTP ${response.status}`);
    }
    return body as T;
  }
}
