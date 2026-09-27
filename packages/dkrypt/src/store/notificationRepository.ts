import type { Database } from 'bun:sqlite';
import type { NotificationRecord } from '#store/state.js';

export interface NotificationRepository {
  listByUser(userId: string): NotificationRecord[];
}

export function createNotificationRepository(database: Database): NotificationRepository {
  const statement = database.query('SELECT payload FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC;');
  return {
    listByUser(userId) {
      const rows = statement.all(userId.toLowerCase()) as Array<{ payload: string }>;
      return rows.map((row) => JSON.parse(row.payload) as NotificationRecord);
    },
  };
}
