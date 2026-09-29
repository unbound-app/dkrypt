import type { Database } from 'bun:sqlite';
import type { NotificationRecord } from '#store/state.js';
import { decodeKeysetCursor, paginateCursor } from '#util/cursor.js';

export interface NotificationPageQuery {
  cursor?: string;
  offset?: number;
  limit: number;
}

export interface NotificationPage {
  notifications: NotificationRecord[];
  unread: number;
  total: number;
  nextCursor?: string;
}

export interface NotificationRepository {
  listByUser(userId: string): NotificationRecord[];
  listPageByUser(userId: string, query: NotificationPageQuery): NotificationPage;
}

const notificationCursorKey = (notification: NotificationRecord) => [notification.createdAt, notification.id] as const;

export function createNotificationRepository(database: Database): NotificationRepository {
  const statement = database.query('SELECT payload FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC;');
  const countByUser = database.query(`
    SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END), 0) AS unread
    FROM notifications
    WHERE user_id = lower(?);
  `);
  const firstPage = database.query(`
    SELECT payload
    FROM notifications
    WHERE user_id = lower(?)
    ORDER BY created_at DESC, id DESC
    LIMIT ?;
  `);
  const followingPage = database.query(`
    SELECT payload
    FROM notifications
    WHERE user_id = lower(?)
      AND (created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at DESC, id DESC
    LIMIT ?;
  `);

  function listByUser(userId: string): NotificationRecord[] {
    const rows = statement.all(userId.toLowerCase()) as Array<{ payload: string }>;
    return parseRows(rows);
  }

  function parseRows(rows: Array<{ payload: string }>): NotificationRecord[] {
    return rows.map((row) => JSON.parse(row.payload) as NotificationRecord);
  }

  function userCounts(userId: string): { total: number; unread: number } {
    const row = countByUser.get(userId) as { total: number; unread: number };
    return { total: row.total, unread: row.unread };
  }

  return {
    listByUser,
    listPageByUser(userId, query) {
      const limit = Math.min(Math.max(Math.floor(query.limit), 1), 100);
      const cursorKey = decodeKeysetCursor(query.cursor);
      const supportsNotificationCursor = cursorKey?.length === 2
        && typeof cursorKey[0] === 'number'
        && typeof cursorKey[1] === 'string';

      if ((query.cursor !== undefined && !supportsNotificationCursor) || (query.offset ?? 0) > 0) {
        const notifications = listByUser(userId);
        const page = paginateCursor(notifications, {
          cursor: query.cursor,
          offset: query.offset,
          limit,
          keyOf: notificationCursorKey,
          order: 'desc',
        });
        return {
          notifications: page.items,
          unread: notifications.filter((notification) => !notification.readAt).length,
          total: notifications.length,
          nextCursor: page.nextCursor,
        };
      }

      const rows = (supportsNotificationCursor
        ? followingPage.all(userId, cursorKey[0], cursorKey[0], cursorKey[1], limit + 1)
        : firstPage.all(userId, limit + 1)) as Array<{ payload: string }>;
      const page = paginateCursor(parseRows(rows), {
        limit,
        keyOf: notificationCursorKey,
        order: 'desc',
      });
      const counts = userCounts(userId);
      return { notifications: page.items, nextCursor: page.nextCursor, ...counts };
    },
  };
}
