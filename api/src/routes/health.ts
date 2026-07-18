import { Router } from 'express';
import { requireApiKey } from '../auth.js';
import { getEffectiveWatches, isWatchSchedulable } from '../store/state.js';

export const healthRouter = Router();

healthRouter.get('/v1/health', requireApiKey, (_req, res) => {
  res.json({ ok: true, schedulerEnabled: getEffectiveWatches().some(isWatchSchedulable) });
});
