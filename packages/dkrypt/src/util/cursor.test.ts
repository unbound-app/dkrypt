import { describe, expect, test } from 'bun:test';
import { decodeCursor, encodeCursor, nextCursor, paginateCursor } from '#util/cursor.js';

describe('cursor pagination', () => {
  test('preserves legacy offset cursor helpers for unconverted lists', () => {
    const cursor = encodeCursor(42);
    expect(decodeCursor(cursor)).toBe(42);
    expect(decodeCursor('not-a-cursor')).toBe(0);
    expect(nextCursor(0, 10, 20)).toBe(encodeCursor(10));
    expect(nextCursor(10, 10, 20)).toBeUndefined();
  });

  test('continues after the last item even when newer rows arrive between pages', () => {
    const rows = [
      { id: 'job-d', finishedAt: 400 },
      { id: 'job-c', finishedAt: 300 },
      { id: 'job-b', finishedAt: 200 },
      { id: 'job-a', finishedAt: 100 },
    ];
    const keyOf = (row: (typeof rows)[number]) => [row.finishedAt, row.id] as const;
    const firstPage = paginateCursor(rows, { limit: 2, keyOf, order: 'desc' });
    const rowsAfterInsertion = [{ id: 'job-new', finishedAt: 500 }, ...rows];
    const secondPage = paginateCursor(rowsAfterInsertion, {
      limit: 2,
      cursor: firstPage.nextCursor,
      keyOf,
      order: 'desc',
    });

    expect(firstPage.items.map((row) => row.id)).toEqual(['job-d', 'job-c']);
    expect(secondPage.items.map((row) => row.id)).toEqual(['job-b', 'job-a']);
  });

  test('continues legacy offset cursors and emits stable cursors on subsequent pages', () => {
    const rows = [
      { id: 'job-d', finishedAt: 400 },
      { id: 'job-c', finishedAt: 300 },
      { id: 'job-b', finishedAt: 200 },
      { id: 'job-a', finishedAt: 100 },
    ];
    const legacyCursor = Buffer.from(JSON.stringify({ offset: 2 })).toString('base64url');
    const page = paginateCursor(rows, {
      limit: 2,
      cursor: legacyCursor,
      keyOf: (row) => [row.finishedAt, row.id],
      order: 'desc',
    });

    expect(page.items.map((row) => row.id)).toEqual(['job-b', 'job-a']);
    expect(page.nextCursor).toBeUndefined();
  });

  test('returns an empty page when the cursor is beyond the remaining results', () => {
    const rows = [
      { id: 'job-d', finishedAt: 400 },
      { id: 'job-c', finishedAt: 300 },
      { id: 'job-b', finishedAt: 200 },
      { id: 'job-a', finishedAt: 100 },
    ];
    const firstPage = paginateCursor(rows, {
      limit: 3,
      keyOf: (row) => [row.finishedAt, row.id],
      order: 'desc',
    });
    const cursorPage = paginateCursor(rows.slice(0, 2), {
      limit: 2,
      cursor: firstPage.nextCursor,
      keyOf: (row) => [row.finishedAt, row.id],
      order: 'desc',
    });

    expect(cursorPage.items).toEqual([]);
    expect(cursorPage.nextCursor).toBeUndefined();
  });
});
