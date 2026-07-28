function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRY_DELAY_MS = 2000;
const MAX_RETRY_DELAY_MS = 10_000;

export interface WebhookPostResult {
  ok: boolean;
  status?: number;
  error?: string;
  durationMs: number;
}

async function retryDelayMs(res: Response): Promise<number> {
  if (res.status !== 429) return RETRY_DELAY_MS;
  try {
    const body = (await res.clone().json()) as { retry_after?: number };
    if (typeof body.retry_after === 'number') return Math.min(body.retry_after * 1000, MAX_RETRY_DELAY_MS);
  } catch {}
  return RETRY_DELAY_MS;
}

export async function postJsonWithRetry(url: string, body: unknown): Promise<WebhookPostResult> {
  const payload = JSON.stringify(body);
  const startedAt = Date.now();

  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
      if (res.ok) return { ok: true, status: res.status, durationMs: Date.now() - startedAt };
      if (attempt === 0) {
        await sleep(await retryDelayMs(res));
        continue;
      }
      return { ok: false, status: res.status, durationMs: Date.now() - startedAt };
    } catch (err) {
      if (attempt === 0) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return { ok: false, error: String(err), durationMs: Date.now() - startedAt };
    }
  }

  return { ok: false, durationMs: Date.now() - startedAt };
}
