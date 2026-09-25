import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { fastifyRequireApiKey } from '#auth.js';
import { peekPrimaryDeviceHealth } from '#deviceHealth.js';
import { getRustDeviceBridgeStatus } from '#idevice.js';
import { getEffectiveWatches, getPrimaryDevice, getStateDatabaseStatus, isWatchSchedulable } from '#store/state.js';
import { renderMetrics } from '#metrics.js';
import { getMaintenanceStatus } from '#maintenance.js';
import { getRouteContract } from '#contracts.js';

export const healthRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.get('/v1/health', { schema: getRouteContract('GET', '/v1/health'), preHandler: fastifyRequireApiKey }, async (_req, reply) => {
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
    return reply.send({
      ok: database.integrity === 'ok',
      serviceReady: database.integrity === 'ok' && bridge.state === 'ready',
      schedulerEnabled,
      database,
      bridge,
      device: {
        reachable: device?.reachable ?? false,
        bridgeReachable: device?.testFlightBridgeReachable ?? false,
        transport: primary?.transport ?? (primary?.udid ? 'usb' : primary ? 'wifi' : undefined),
        transportState: device?.transportState ?? (primary ? 'connecting' : 'unsupported'),
        capabilities: device?.capabilities ?? [],
        lastSeenAt: device?.lastSeenAt,
        recoveryState: device?.recoveryState ?? (primary ? 'recovering' : 'offline'),
        readiness: device?.readiness?.state ?? (primary ? 'unknown' : 'setup_required'),
        subsystems: device?.subsystems,
        bridgeHeartbeats: device?.bridgeHeartbeats,
      },
    });
  });

  server.get('/v1/status', { schema: getRouteContract('GET', '/v1/status') }, async () => getPublicStatus());

  server.get('/v1/metrics', { schema: getRouteContract('GET', '/v1/metrics'), preHandler: fastifyRequireApiKey }, async (_request, reply) => {
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(renderMetrics());
  });
};

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
