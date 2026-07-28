export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: number;
}

export const rateLimitState = $state<Record<string, RateLimitInfo>>({});
