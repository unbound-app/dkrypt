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

export function assertDeploymentPublicStatus(value: unknown): void {
  const status = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const components = status.components && typeof status.components === 'object' ? status.components as Record<string, unknown> : {};
  const componentState = (name: string): unknown => {
    const component = components[name];
    return component && typeof component === 'object' ? (component as Record<string, unknown>).state : undefined;
  };
  const serviceReady = componentState('service') === 'operational';
  const automationReady = componentState('automation') === 'operational';
  const schedulerState = componentState('scheduler');
  const overallReady = status.status === 'operational'
    ? schedulerState === 'operational' || schedulerState === 'paused'
    : status.status === 'degraded' && schedulerState === 'degraded';

  if (serviceReady && automationReady && overallReady) return;
  throw new Error(`deployment is not operational after device recovery: ${JSON.stringify(value)}`);
}
