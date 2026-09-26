import type { Session } from '#session.js';
import { recordUserActivity, touchSessionRecord } from '#store/state.js';

export function recordDashboardSessionActivity(session: Pick<Session, 'sub' | 'sid'>): void {
  recordUserActivity(session.sub);
  touchSessionRecord(session.sid);
}
