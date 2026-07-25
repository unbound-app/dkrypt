import type { NextFunction, Request, Response } from 'express';
import { peekPrimaryDeviceHealth } from '#deviceHealth.js';
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
    if (!health.reachable) {
      auto = true;
      autoReason = 'the iDevice is unreachable';
    } else if (health.internetAccess === false) {
      auto = true;
      autoReason = 'the iDevice has no internet access';
    } else if (health.testFlightBridgeReachable === false) {
      auto = true;
      autoReason = 'the autoinstall bridge is unresponsive';
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
