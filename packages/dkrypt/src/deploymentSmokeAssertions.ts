import type { DeviceSubsystemState } from './deviceHealth.js';

export interface DeploymentSmokeLoginState {
  authenticated: boolean;
  rootMfaChallenge: boolean;
}

export function inspectDeploymentSmokeLogin(status: number, code: unknown): DeploymentSmokeLoginState {
  if (status >= 200 && status < 300) return { authenticated: true, rootMfaChallenge: false };
  if (status === 401 && code === 'mfa_required') return { authenticated: false, rootMfaChallenge: true };
  throw new Error(`smoke login failed: HTTP ${status}, code=${typeof code === 'string' ? code : 'unknown'}`);
}

export function assertDatabaseSchemaVersion(actual: unknown, expected: number): asserts actual is number {
  if (typeof actual !== 'number' || !Number.isInteger(actual) || actual !== expected) {
    throw new Error(`database schema mismatch: expected ${expected}, received ${typeof actual === 'number' ? actual : 'unknown'}`);
  }
}

export function assertAppStoreSubsystemWhenAgentReady(agentState: DeviceSubsystemState, appStoreState: DeviceSubsystemState): void {
  if (agentState !== 'ready' || appStoreState === 'ready' || appStoreState === 'idle') return;
  throw new Error(`App Store subsystem is ${appStoreState} while the device agent is ready`);
}
