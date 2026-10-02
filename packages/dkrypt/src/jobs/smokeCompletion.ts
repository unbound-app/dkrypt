export interface SmokeDecryptArtifact {
  artifactId: string;
  sha256: string;
  sizeBytes: number;
}

export interface WaitForSmokeDecryptCompletionOptions {
  baseUrl: string;
  jobId: string;
  sessionCookie: string;
  pollIntervalMs: number;
}

export function isSmokeDecryptActive(status: unknown, executionStage: unknown): boolean {
  return status === 'running' && executionStage === 'decrypting';
}

export async function waitForSmokeDecryptCompletion({
  baseUrl,
  jobId,
  sessionCookie,
  pollIntervalMs,
}: WaitForSmokeDecryptCompletionOptions): Promise<SmokeDecryptArtifact> {
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) throw new Error('decrypt smoke poll interval must be positive');
  const statusUrl = new URL(`/v1/dashboard/jobs/${encodeURIComponent(jobId)}/status`, baseUrl);

  while (true) {
    const response = await fetch(statusUrl, {
      headers: { cookie: sessionCookie },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`dashboard job status failed with HTTP ${response.status}`);

    let status: Record<string, unknown>;
    try {
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('invalid response');
      status = body as Record<string, unknown>;
    } catch {
      throw new Error('dashboard job status returned invalid JSON');
    }

    const progress = typeof status.progress === 'string' && status.progress.length > 0 ? status.progress : 'unknown stage';
    if (status.status === 'failed') {
      const error = typeof status.error === 'string' && status.error.length > 0 ? status.error : 'no error details';
      throw new Error(`decrypt job failed after restart at ${progress}: ${error}`);
    }
    if (status.status === 'done') {
      if (
        typeof status.artifactId !== 'string' || status.artifactId.length === 0
        || typeof status.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(status.sha256)
        || typeof status.sizeBytes !== 'number' || !Number.isSafeInteger(status.sizeBytes) || status.sizeBytes <= 0
      ) {
        throw new Error('decrypt job completed without a valid artifact id, SHA-256, and size');
      }
      return { artifactId: status.artifactId, sha256: status.sha256, sizeBytes: status.sizeBytes };
    }

    const deadlineAt = typeof status.deadlineAt === 'string' ? Date.parse(status.deadlineAt) : Number.NaN;
    if (!Number.isFinite(deadlineAt)) throw new Error(`decrypt job has no valid deadline after restart at ${progress}`);
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error(`decrypt job deadline elapsed after restart at ${progress}`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
  }
}
