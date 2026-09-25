import { accessSync, constants, existsSync } from 'node:fs';
import { config, cryptoBillingEnabled, nowpaymentsConfigured, stripeEnabled, stripeEnvironment } from '#config.js';
import { getRustDeviceBridgeStatus } from '#idevice.js';
import { getNowPaymentsProviderStatus } from '#nowpayments.js';
import { getStateDatabaseStatus, verifyLatestDatabaseBackup } from '#store/state.js';
import { getDiskUsage } from '#util/diskUsage.js';

export interface DoctorCheck {
  id: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

function rotationCheck(id: string, current: string, previous: string, minimumLength: number): DoctorCheck {
  const valid = !previous || (previous.length >= minimumLength && previous !== current);
  return {
    id,
    status: valid ? 'ok' : 'error',
    detail: valid ? (previous ? 'Current and previous credentials are ready for rotation' : 'No overlapping previous credential is configured') : 'Previous credential is too short or matches the current credential',
  };
}

export async function runConfigurationDoctor(): Promise<{ ok: boolean; checkedAt: string; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const secretStatus = config.sessionSigningSecret.length >= 32 ? 'ok' : 'error';
  checks.push({ id: 'session-secret', status: secretStatus, detail: secretStatus === 'ok' ? 'Session signing secret has sufficient entropy' : 'Session signing secret must be at least 32 characters' });
  checks.push(rotationCheck('session-secret-rotation', config.sessionSigningSecret, config.sessionSigningSecretPrevious, 32));
  checks.push(rotationCheck('admin-password-rotation', config.adminPassword, config.adminPasswordPrevious, 12));
  checks.push({ id: 'admin-password', status: config.adminPassword.length >= 12 ? 'ok' : 'warn', detail: config.adminPassword.length >= 12 ? 'Administrator password meets the minimum length' : 'Administrator password should be at least 12 characters' });
  try {
    const baseUrl = new URL(config.publicBaseUrl);
    checks.push({ id: 'public-url', status: baseUrl.protocol === 'https:' ? 'ok' : 'warn', detail: baseUrl.protocol === 'https:' ? 'Public URL uses HTTPS' : 'Public URL does not use HTTPS' });
  } catch {
    checks.push({ id: 'public-url', status: 'error', detail: 'Public URL is not a valid absolute URL' });
  }
  const timingSettings = [config.jobMaxWaitSeconds, config.jobMaxRetries, config.jobProcessGraceSeconds, config.jobRetentionMinutes, config.stateDbBusyTimeoutMs];
  checks.push({ id: 'runtime-limits', status: timingSettings.every((value) => Number.isInteger(value) && value > 0) ? 'ok' : 'error', detail: timingSettings.every((value) => Number.isInteger(value) && value > 0) ? 'Runtime limits are valid' : 'Runtime limits must be positive integers' });
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
  const backup = verifyLatestDatabaseBackup();
  checks.push({ id: 'backup-restore-drill', status: backup.ok ? 'ok' : backup.detail.startsWith('No verified') ? 'warn' : 'error', detail: backup.detail });
  if (config.deviceBridgeSecret.length < 32) checks.push({ id: 'device-bridge', status: 'error', detail: 'Rust device bridge secret is missing or too short' });
  else if (!existsSync(config.deviceBridgeSocket)) checks.push({ id: 'device-bridge', status: 'warn', detail: 'Rust device bridge socket is not available yet' });
  else {
    try {
      const bridge = await getRustDeviceBridgeStatus();
      checks.push({ id: 'device-bridge', status: bridge.state === 'ready' ? 'ok' : 'warn', detail: `Rust bridge is ${bridge.state} with ${bridge.deviceCount} discovered device(s)` });
    } catch (error) {
      checks.push({ id: 'device-bridge', status: 'error', detail: error instanceof Error ? error.message : String(error) });
    }
  }
  checks.push(rotationCheck('device-bridge-rotation', config.deviceBridgeSecret, config.deviceBridgeSecretPrevious, 32));
  checks.push(rotationCheck('stripe-webhook-rotation', config.stripeWebhookSecret, config.stripeWebhookSecretPrevious, 16));
  checks.push(rotationCheck('crypto-webhook-rotation', config.nowpaymentsIpnSecret, config.nowpaymentsIpnSecretPrevious, 16));
  checks.push(rotationCheck('outbound-webhook-rotation', config.outboundWebhookSecret, config.outboundWebhookSecretPrevious, 16));
  checks.push({ id: 'pairing-store', status: existsSync(config.devicePairingStore) ? 'ok' : 'warn', detail: existsSync(config.devicePairingStore) ? 'Device pairing store exists' : 'Device pairing store will be created on first bridge start' });
  const otelSignals = [
    config.otelExporterOtlpEndpoint || config.otelExporterOtlpTracesEndpoint ? 'traces' : undefined,
    config.otelExporterOtlpEndpoint || config.otelExporterOtlpMetricsEndpoint ? 'metrics' : undefined,
  ].filter((signal): signal is string => !!signal);
  checks.push({ id: 'otel', status: otelSignals.length ? 'ok' : 'warn', detail: otelSignals.length ? `OTLP ${otelSignals.join(' and ')} configured for ${config.otelServiceName}` : 'OTLP export is disabled; Prometheus metrics remain available' });
  checks.push({ id: 'stripe', status: stripeEnabled ? 'ok' : 'warn', detail: stripeEnabled ? `Stripe is configured in ${stripeEnvironment} mode` : 'Stripe billing is missing runtime configuration' });
  if (cryptoBillingEnabled || nowpaymentsConfigured) {
    const crypto = await getNowPaymentsProviderStatus();
    checks.push({ id: 'crypto', status: crypto.ready ? 'ok' : crypto.enabled ? 'error' : 'warn', detail: crypto.ready ? 'NOWPayments crypto billing is ready' : crypto.issues.join(', ') || 'Crypto billing is disabled' });
  } else checks.push({ id: 'crypto', status: 'warn', detail: 'Crypto billing is disabled' });
  return { ok: checks.every((check) => check.status !== 'error'), checkedAt: new Date().toISOString(), checks };
}
