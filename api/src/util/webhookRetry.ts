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

// Discord's 429 body includes a retry_after (seconds) that's usually far more accurate than a
// blind fixed delay - fall back to the fixed delay for a non-Discord receiver or a malformed body.
async function retryDelayMs(res: Response): Promise<number> {
  if (res.status !== 429) return RETRY_DELAY_MS;
  try {
    const body = (await res.clone().json()) as { retry_after?: number };
    if (typeof body.retry_after === 'number') return Math.min(body.retry_after * 1000, MAX_RETRY_DELAY_MS);
  } catch {}
  return RETRY_DELAY_MS;
}

// One retry (2 attempts total) with a short fixed delay, honoring a Discord-style 429 retry_after
// when present. Shared by the scheduler's Discord/Slack notification webhook and the generic
// per-job-completion webhook - both just need "post this JSON body, retry once on failure."
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

  // Unreachable - the loop always returns on its second (last) iteration.
  return { ok: false, durationMs: Date.now() - startedAt };
}
