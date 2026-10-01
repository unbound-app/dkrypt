type HealthFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface DatabaseHealthProbeOptions {
  fetcher?: HealthFetcher;
  baseUrl?: string;
  apiKey?: string;
}

export async function assertDatabaseHealth(options: DatabaseHealthProbeOptions = {}): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = options.baseUrl ?? `http://127.0.0.1:${process.env.PORT || 8080}`;
  const apiKey = options.apiKey ?? process.env.API_KEY ?? '';
  const response = await fetcher(`${baseUrl}/v1/health`, { headers: { authorization: `Bearer ${apiKey}` } });
  const body = await response.json().catch(() => ({})) as { database?: { integrity?: unknown } };
  if (!response.ok || body.database?.integrity !== 'ok') {
    throw new Error(`health probe failed: HTTP ${response.status}, database integrity is ${String(body.database?.integrity ?? 'unknown')}`);
  }
}

if (import.meta.main) {
  try {
    await assertDatabaseHealth();
  } catch (error) {
    console.error(`deployment health probe failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
