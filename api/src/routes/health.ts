import { Router } from 'express';
import { requireApiKey } from '../auth.js';
import { schedulerEnabled } from '../config.js';

export const healthRouter = Router();

// Authenticated even for health checks - "no unauthenticated requests" is a
// hard requirement here, so point your compose/orchestrator healthcheck at
// this with the API key rather than an open /healthz.
healthRouter.get('/v1/health', requireApiKey, (_req, res) => {
  res.json({ ok: true, schedulerEnabled });
});
