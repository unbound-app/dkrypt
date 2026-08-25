export const BRIDGE_PROTOCOL_VERSION = 1;

export const BRIDGE_CAPABILITIES = {
  springboard: ['dark_on', 'dark_off', 'launch_app', 'screen_status', 'status', 'protocol_v1', 'authenticated_requests', 'operation_responses', 'heartbeats', 'stale_artifact_cleanup'],
  testflight: ['list_trains', 'list_builds', 'install', 'diagnostics', 'idempotent_install', 'protocol_v1', 'authenticated_requests', 'operation_responses', 'heartbeats', 'stale_artifact_cleanup'],
  appstore: ['install', 'status', 'diagnostics', 'foreground_status', 'protocol_v1', 'authenticated_requests', 'operation_responses', 'heartbeats', 'stale_artifact_cleanup'],
} as const;

export type BridgeChannel = keyof typeof BRIDGE_CAPABILITIES;

export function hasBridgeCapabilities(channel: BridgeChannel, capabilities: unknown): boolean {
  if (!Array.isArray(capabilities)) return false;
  const reported = capabilities.filter((value): value is string => typeof value === 'string');
  return BRIDGE_CAPABILITIES[channel].every((capability) => reported.includes(capability));
}
