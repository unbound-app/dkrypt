export function decodeCursor(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { offset?: unknown };
    return typeof parsed.offset === 'number' && Number.isInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset: Math.max(0, Math.floor(offset)) }), 'utf8').toString('base64url');
}

export function nextCursor(offset: number, limit: number, total: number): string | undefined {
  const nextOffset = offset + limit;
  return nextOffset < total ? encodeCursor(nextOffset) : undefined;
}
