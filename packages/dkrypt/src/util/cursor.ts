export type CursorScalar = string | number;

export type CursorKey = readonly CursorScalar[];

interface KeysetCursor {
  version: 1;
  key: CursorKey;
}

interface LegacyOffsetCursor {
  offset: number;
}

interface CursorPageOptions<T> {
  limit: number;
  cursor?: string;
  offset?: number;
  keyOf: (item: T) => CursorKey;
  order: 'asc' | 'desc';
}

interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
}

function isCursorKey(value: unknown): value is CursorKey {
  return Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every((part) =>
    (typeof part === 'string' && part.length <= 256) || (typeof part === 'number' && Number.isFinite(part))
  );
}

function decodeCursorPayload(value: string | undefined): KeysetCursor | LegacyOffsetCursor | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { version?: unknown; key?: unknown; offset?: unknown };
    if (parsed.version === 1 && isCursorKey(parsed.key)) return { version: 1, key: parsed.key };
    if (typeof parsed.offset === 'number' && Number.isInteger(parsed.offset) && parsed.offset >= 0) return { offset: parsed.offset };
  } catch {
    return undefined;
  }
  return undefined;
}

function compareKey(left: CursorKey, right: CursorKey): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const first = left[index];
    const second = right[index];
    if (first === second) continue;
    if (typeof first === 'number' && typeof second === 'number') return first < second ? -1 : 1;
    const firstText = String(first);
    const secondText = String(second);
    return firstText < secondText ? -1 : 1;
  }
  return left.length - right.length;
}

function compareOrderedKeys(left: CursorKey, right: CursorKey, order: 'asc' | 'desc'): number {
  const result = compareKey(left, right);
  return order === 'asc' ? result : -result;
}

function encodeKeysetCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify({ version: 1, key }), 'utf8').toString('base64url');
}

export function paginateCursor<T>(items: readonly T[], options: CursorPageOptions<T>): CursorPage<T> {
  const ordered = [...items].sort((left, right) => compareOrderedKeys(options.keyOf(left), options.keyOf(right), options.order));
  const cursor = decodeCursorPayload(options.cursor);
  const firstAfterCursor = cursor && 'key' in cursor
    ? ordered.findIndex((item) => compareOrderedKeys(options.keyOf(item), cursor.key, options.order) > 0)
    : undefined;
  const start = cursor && 'offset' in cursor
    ? cursor.offset
    : firstAfterCursor !== undefined
      ? firstAfterCursor < 0 ? ordered.length : firstAfterCursor
      : Math.max(options.offset ?? 0, 0);
  const startIndex = Math.max(start, 0);
  const limit = Math.max(1, Math.floor(options.limit));
  const page = ordered.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + page.length < ordered.length;
  const lastItem = page.at(-1);
  return {
    items: page,
    nextCursor: hasMore && lastItem ? encodeKeysetCursor(options.keyOf(lastItem)) : undefined,
  };
}
