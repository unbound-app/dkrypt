import { Router } from '#http.js';
import { requireApiKey } from '#auth.js';
import { peekPrimaryDeviceHealth } from '#deviceHealth.js';
import { getRustDeviceBridgeStatus } from '#idevice.js';
import { getEffectiveWatches, getPrimaryDevice, getStateDatabaseStatus, isWatchSchedulable } from '#store/state.js';
import { renderMetrics } from '#metrics.js';

export const healthRouter = Router();

healthRouter.get('/v1/health', requireApiKey, async (_req, res) => {
  const primary = getPrimaryDevice();
  const device = peekPrimaryDeviceHealth();
  const schedulerEnabled = getEffectiveWatches().some(isWatchSchedulable);
  let bridge: { state: 'ready' | 'offline'; transport: string; deviceCount: number; capabilities: string[] };
  try {
    bridge = await getRustDeviceBridgeStatus();
  } catch {
    bridge = { state: 'offline', transport: 'rust-netmuxd', deviceCount: 0, capabilities: [] };
  }
  const database = getStateDatabaseStatus();
  res.json({
    ok: database.integrity === 'ok',
    serviceReady: database.integrity === 'ok' && bridge.state === 'ready',
    schedulerEnabled,
    database,
    bridge,
    device: { reachable: device?.reachable ?? false, bridgeReachable: device?.testFlightBridgeReachable ?? false, readiness: device?.readiness?.state ?? (primary ? 'unknown' : 'setup_required') },
  });
});

healthRouter.get('/v1/metrics', requireApiKey, (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(renderMetrics());
});
