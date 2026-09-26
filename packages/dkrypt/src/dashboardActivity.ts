import { getFastifySession, type Session } from '#session.js';
import { recordUserActivity, touchSessionRecord } from '#store/state.js';
import type { FastifyRequest, HookHandlerDoneFunction } from 'fastify';

export function recordDashboardSessionActivity(session: Pick<Session, 'sub' | 'sid'>): void {
  recordUserActivity(session.sub);
  touchSessionRecord(session.sid);
}

export function recordFastifyDashboardActivity(request: FastifyRequest, _reply: unknown, done: HookHandlerDoneFunction): void {
  const session = getFastifySession(request);
  if (session) recordDashboardSessionActivity(session);
  done();
}
