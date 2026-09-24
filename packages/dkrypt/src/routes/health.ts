import { Router } from '#http.js';
import { requireApiKey } from '#auth.js';
import { peekPrimaryDeviceHealth } from '#deviceHealth.js';
import { getEffectiveWatches, getPrimaryDevice, getStateDatabaseStatus, isWatchSchedulable } from '#store/state.js';
import { renderMetrics } from '#metrics.js';

export const healthRouter = Router();

healthRouter.get('/v1/health', requireApiKey, (_req, res) => {
  const primary = getPrimaryDevice();
  const device = peekPrimaryDeviceHealth();
  const schedulerEnabled = getEffectiveWatches().some(isWatchSchedulable);
  res.json({
    ok: primary ? Boolean(device?.reachable) : true,
    schedulerEnabled,
    database: getStateDatabaseStatus(),
    device: { reachable: device?.reachable ?? false, bridgeReachable: device?.testFlightBridgeReachable ?? false, readiness: device?.readiness?.state ?? (primary ? 'unknown' : 'setup_required') },
  });
});

healthRouter.get('/v1/metrics', requireApiKey, (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(renderMetrics());
});
