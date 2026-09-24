import { describe, expect, test } from 'bun:test';
import { decodeCursor, encodeCursor, nextCursor } from '#util/cursor.js';

describe('cursor pagination', () => {
  test('round-trips offsets and rejects malformed values', () => {
    const cursor = encodeCursor(42);
    expect(decodeCursor(cursor)).toBe(42);
    expect(decodeCursor('not-a-cursor')).toBe(0);
    expect(decodeCursor(undefined)).toBe(0);
  });

  test('returns a cursor only when another page exists', () => {
    expect(nextCursor(0, 10, 20)).toBe(encodeCursor(10));
    expect(nextCursor(10, 10, 20)).toBeUndefined();
  });
});
