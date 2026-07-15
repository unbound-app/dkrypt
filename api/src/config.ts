function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`env var ${name} must be an integer, got ${v}`);
  return n;
}

export const config = {
  port: optionalInt('PORT', 8080),
  // Bind to loopback explicitly, since network_mode: host would otherwise
  // expose the app on the whole LAN rather than just via Caddy.
  bindHost: optional('BIND_HOST', '127.0.0.1'),

  // auth
  apiKey: required('API_KEY'),
  downloadSigningSecret: required('DOWNLOAD_SIGNING_SECRET'),
  publicBaseUrl: optional('PUBLIC_BASE_URL', 'http://localhost:8080'),

  // admin dashboard - the root/recovery login, kept separate from API_KEY
  // so the two can be rotated independently; normal users sign in via
  // GitHub OAuth below.
  adminPassword: required('ADMIN_PASSWORD'),
  stateDir: optional('STATE_DIR', '/data/state'),

  // GitHub OAuth for dashboard login. Leave both blank to disable it.
  githubOauthClientId: optional('GITHUB_OAUTH_CLIENT_ID', ''),
  githubOauthClientSecret: optional('GITHUB_OAUTH_CLIENT_SECRET', ''),

  // ipadecrypt
  ipadecryptBin: optional('IPADECRYPT_BIN', 'ipadecrypt'),
  outputDir: optional('OUTPUT_DIR', '/data/tmp'),
  ipadecryptConfigPath: optional('IPADECRYPT_CONFIG_PATH', '/root/.ipadecrypt/config.json'),

  // job lifecycle
  jobMaxWaitSeconds: optionalInt('JOB_MAX_WAIT_SECONDS', 1800),
  fileTtlMinutes: optionalInt('FILE_TTL_MINUTES', 15),
  jobRetentionMinutes: optionalInt('JOB_RETENTION_MINUTES', 60),

  // scheduler: automated bundle watch -> github dispatch
  watchBundleId: optional('WATCH_BUNDLE_ID', ''),
  watchAppRepo: optional('WATCH_APP_REPO', ''),
  ghDispatchRepo: optional('GH_DISPATCH_REPO', ''),
  ghWorkflowFile: optional('GH_WORKFLOW_FILE', 'remote-ipa-update.yml'),
  ghToken: optional('GH_TOKEN', ''),
  pollCron: optional('POLL_CRON', '0 * * * *'),
  runPollIntervalSeconds: optionalInt('RUN_POLL_INTERVAL_SECONDS', 15),
  runPollTimeoutMinutes: optionalInt('RUN_POLL_TIMEOUT_MINUTES', 30),
  notifyWebhookUrl: optional('NOTIFY_WEBHOOK_URL', ''),
};

export const githubOauthEnabled = config.githubOauthClientId !== '' && config.githubOauthClientSecret !== '';
