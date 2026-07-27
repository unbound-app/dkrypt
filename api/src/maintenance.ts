import type { NextFunction, Request, Response } from '#http.js';
import { getDeviceReadiness, peekPrimaryDeviceHealth } from '#deviceHealth.js';
import { getEffectiveSettings } from '#store/state.js';

export interface MaintenanceStatus {
  active: boolean;
  manual: boolean;
  auto: boolean;
  reason?: string;
}

export function getMaintenanceStatus(): MaintenanceStatus {
  const manual = getEffectiveSettings().maintenanceMode;

  let auto = false;
  let autoReason: string | undefined;
  const health = peekPrimaryDeviceHealth();
  if (health) {
    const readiness = health.readiness ?? getDeviceReadiness(health);
    if (readiness.state === 'blocked') {
      auto = true;
      autoReason = readiness.reasons[0] ?? 'the iDevice is not ready for automation';
    }
  }

  return {
    active: manual || auto,
    manual,
    auto,
    reason: manual ? 'maintenance mode is enabled' : autoReason,
  };
}

export function blockDuringMaintenance(_req: Request, res: Response, next: NextFunction): void {
  const status = getMaintenanceStatus();
  if (status.active) {
    res.status(503).json({ error: `decrypts are paused for maintenance${status.reason ? ` - ${status.reason}` : ''}`, maintenance: true });
    return;
  }
  next();
}
