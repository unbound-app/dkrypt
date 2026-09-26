export function apiErrorMessage(data: unknown, statusCode: number): string {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return `Request failed (${statusCode})`;
  const payload = data as Record<string, unknown>;
  const error = typeof payload.error === 'string' ? payload.error : `Request failed (${statusCode})`;
  if (error !== 'internal server error' || typeof payload.remediation !== 'object' || payload.remediation === null || Array.isArray(payload.remediation)) {
    return error;
  }

  const remediation = payload.remediation as Record<string, unknown>;
  if (typeof remediation.action !== 'string' || !remediation.action.trim()) return error;
  const rawService = typeof remediation.service === 'string' && remediation.service.trim() ? remediation.service.trim() : 'service';
  const service = `${rawService.charAt(0).toUpperCase()}${rawService.slice(1)}`;
  const upstreamStatus = typeof remediation.upstreamStatus === 'number' && Number.isInteger(remediation.upstreamStatus)
    ? ` (HTTP ${remediation.upstreamStatus})`
    : '';
  return `${service} request failed${upstreamStatus}. ${remediation.action.trim()}`;
}
