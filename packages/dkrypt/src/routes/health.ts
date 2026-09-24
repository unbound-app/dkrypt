import { Router } from '#http.js';
import { requireApiKey } from '#auth.js';
import { peekPrimaryDeviceHealth } from '#deviceHealth.js';
import { getRustDeviceBridgeStatus } from '#idevice.js';
import { getEffectiveWatches, getPrimaryDevice, getStateDatabaseStatus, isWatchSchedulable } from '#store/state.js';
import { renderMetrics } from '#metrics.js';
import { getMaintenanceStatus } from '#maintenance.js';

export const healthRouter = Router();

type PublicStatusState = 'operational' | 'degraded' | 'maintenance' | 'not_configured' | 'paused' | 'unknown';

interface PublicStatusComponent {
  state: PublicStatusState;
}

export interface PublicStatusResponse {
  status: 'operational' | 'degraded' | 'maintenance';
  checkedAt: string;
  components: {
    service: PublicStatusComponent;
    automation: PublicStatusComponent;
    scheduler: PublicStatusComponent;
  };
}

export async function getPublicStatus(): Promise<PublicStatusResponse> {
  const checkedAt = new Date().toISOString();
  let databaseOk = false;
  try {
    databaseOk = getStateDatabaseStatus().integrity === 'ok';
  } catch {
    databaseOk = false;
  }

  let bridgeReady = false;
  try {
    bridgeReady = (await getRustDeviceBridgeStatus()).state === 'ready';
  } catch {
    bridgeReady = false;
  }

  const primary = getPrimaryDevice();
  const health = peekPrimaryDeviceHealth();
  const maintenance = getMaintenanceStatus();
  const schedulerEnabled = getEffectiveWatches().some(isWatchSchedulable);
  const automation: PublicStatusState = !primary
    ? 'not_configured'
    : maintenance.active
      ? 'maintenance'
      : bridgeReady && health?.reachable && health.readiness?.state === 'ready'
        ? 'operational'
        : health?.reachable
          ? 'degraded'
          : 'unknown';
  const service: PublicStatusState = databaseOk ? 'operational' : 'maintenance';
  const scheduler: PublicStatusState = schedulerEnabled ? 'operational' : 'paused';
  const status = !databaseOk || maintenance.active
    ? 'maintenance'
    : automation === 'degraded' || automation === 'unknown'
      ? 'degraded'
      : 'operational';

  return {
    status,
    checkedAt,
    components: {
      service: { state: service },
      automation: { state: automation },
      scheduler: { state: scheduler },
    },
  };
}

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

healthRouter.get('/v1/status', async (_req, res) => {
  res.json(await getPublicStatus());
});

healthRouter.get('/v1/metrics', requireApiKey, (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(renderMetrics());
});
