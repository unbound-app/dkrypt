import { accessSync, constants, existsSync } from 'node:fs';
import { config, cryptoBillingEnabled, nowpaymentsConfigured, stripeEnabled, stripeEnvironment } from '#config.js';
import { getNowPaymentsProviderStatus } from '#nowpayments.js';
import { getStateDatabaseStatus } from '#store/state.js';
import { getDiskUsage } from '#util/diskUsage.js';

export interface DoctorCheck {
  id: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

export async function runConfigurationDoctor(): Promise<{ ok: boolean; checkedAt: string; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  try {
    const database = getStateDatabaseStatus();
    checks.push({ id: 'database', status: database.integrity === 'ok' ? 'ok' : 'error', detail: `SQLite schema ${database.schemaVersion} is intact` });
  } catch (error) {
    checks.push({ id: 'database', status: 'error', detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    accessSync(config.stateDir, constants.R_OK | constants.W_OK);
    checks.push({ id: 'state', status: 'ok', detail: 'State volume is readable and writable' });
  } catch {
    checks.push({ id: 'state', status: 'error', detail: 'State volume is not readable and writable' });
  }
  const disk = getDiskUsage(config.artifactDir);
  checks.push({ id: 'artifacts', status: disk ? disk.usedPercent >= 0.95 ? 'error' : disk.usedPercent >= 0.85 ? 'warn' : 'ok' : 'error', detail: disk ? `${Math.round(disk.usedPercent * 100)}% used with ${disk.freeBytes} bytes free` : 'Artifact storage is unavailable' });
  if (config.deviceBridgeSecret.length < 32) checks.push({ id: 'device-bridge', status: 'error', detail: 'Rust device bridge secret is missing or too short' });
  else checks.push({ id: 'device-bridge', status: existsSync(config.deviceBridgeSocket) ? 'ok' : 'warn', detail: existsSync(config.deviceBridgeSocket) ? 'Rust device bridge socket is available' : 'Rust device bridge socket is not available yet' });
  checks.push({ id: 'stripe', status: stripeEnabled ? 'ok' : 'warn', detail: stripeEnabled ? `Stripe is configured in ${stripeEnvironment} mode` : 'Stripe billing is missing runtime configuration' });
  if (cryptoBillingEnabled || nowpaymentsConfigured) {
    const crypto = await getNowPaymentsProviderStatus();
    checks.push({ id: 'crypto', status: crypto.ready ? 'ok' : crypto.enabled ? 'error' : 'warn', detail: crypto.ready ? 'NOWPayments crypto billing is ready' : crypto.issues.join(', ') || 'Crypto billing is disabled' });
  } else checks.push({ id: 'crypto', status: 'warn', detail: 'Crypto billing is disabled' });
  return { ok: checks.every((check) => check.status !== 'error'), checkedAt: new Date().toISOString(), checks };
}
