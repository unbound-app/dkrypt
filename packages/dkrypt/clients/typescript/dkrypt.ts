export type DkryptRoute =
  | "GET /v1/artifacts"
  | "GET /v1/artifacts/{id}"
  | "GET /v1/artifacts/{id}/file"
  | "GET /v1/decrypt"
  | "GET /v1/jobs/{id}"
  | "POST /v1/decrypts"
  | "POST /v1/testflight/decrypt";

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
    if (this.apiKey && !result.has('authorization')) result.set('Authorization', `Bearer ${this.apiKey}`);
    if (!result.has('accept')) result.set('Accept', accept);
    return result;
  }

  private async responseError(response: Response): Promise<string> {
    const body = await response.json().catch(() => undefined) as { message?: string; error?: string } | undefined;
    const detail = body && ('message' in body || 'error' in body) ? body.message ?? body.error : undefined;
    return detail ?? `dkrypt request failed with HTTP ${response.status}`;
  }
}
