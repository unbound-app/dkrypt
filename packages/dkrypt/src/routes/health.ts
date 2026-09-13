import { Router } from '#http.js';
import { requireApiKey } from '#auth.js';
import { peekPrimaryDeviceHealth } from '#deviceHealth.js';
import { getEffectiveWatches, getPrimaryDevice, isWatchSchedulable } from '#store/state.js';

export const healthRouter = Router();

healthRouter.get('/v1/health', requireApiKey, (_req, res) => {
  const primary = getPrimaryDevice();
  const device = peekPrimaryDeviceHealth();
  const schedulerEnabled = getEffectiveWatches().some(isWatchSchedulable);
  res.json({
    ok: primary ? Boolean(device?.reachable) : true,
    schedulerEnabled,
    device: { reachable: device?.reachable ?? false, bridgeReachable: device?.testFlightBridgeReachable ?? false, readiness: device?.readiness?.state ?? (primary ? 'unknown' : 'setup_required') },
  });
});
