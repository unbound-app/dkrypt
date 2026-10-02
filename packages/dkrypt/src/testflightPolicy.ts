export const TESTFLIGHT_VERIFICATION_TTL_MS = 30 * 60_000;

export function isTestFlightVerificationFresh(verifiedAt: number | undefined, now = Date.now()): boolean {
  return typeof verifiedAt === 'number'
    && Number.isFinite(verifiedAt)
    && verifiedAt <= now
    && now - verifiedAt <= TESTFLIGHT_VERIFICATION_TTL_MS;
}
