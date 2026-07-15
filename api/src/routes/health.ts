import { Router } from 'express';
import { requireApiKey } from '../auth.js';
import { isSchedulerEnabled } from '../store/state.js';

export const healthRouter = Router();

// No unauthenticated routes at all here, health checks included - point
// your healthcheck at this with the API key rather than an open /healthz.
healthRouter.get('/v1/health', requireApiKey, (_req, res) => {
  res.json({ ok: true, schedulerEnabled: isSchedulerEnabled() });
});
