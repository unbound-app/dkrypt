export function describeHttpError(context: string, res: Response): string {
  const retryAfter = res.headers.get('retry-after');
  const rateRemaining = res.headers.get('x-ratelimit-remaining');
  const isRateLimited = res.status === 429 || (res.status === 403 && rateRemaining === '0');

  if (isRateLimited) {
    return `${context}: rate limited (HTTP ${res.status})${retryAfter ? ` - retry after ${retryAfter}s` : ''}`;
  }
  if (res.status === 503) {
    return `${context}: service temporarily unavailable (HTTP 503)`;
  }
  return `${context}: HTTP ${res.status}`;
}
