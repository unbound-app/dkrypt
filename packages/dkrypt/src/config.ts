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

function optionalBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (!v) return fallback;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`env var ${name} must be true or false, got ${v}`);
}

function optionalList(name: string, fallback: string): string[] {
  return (process.env[name] ?? fallback)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export const config = {
  port: optionalInt('PORT', 8080),
  bindHost: optional('BIND_HOST', '127.0.0.1'),

  apiKey: required('API_KEY'),
  sessionSigningSecret: required('SESSION_SIGNING_SECRET'),
  publicBaseUrl: optional('PUBLIC_BASE_URL', 'http://localhost:8080'),

  adminPassword: required('ADMIN_PASSWORD'),
  stateDir: optional('STATE_DIR', '/data/state'),
  stateDatabaseFile: optional('STATE_DATABASE_FILE', 'dkrypt.sqlite'),
  stateDbBusyTimeoutMs: optionalInt('STATE_DB_BUSY_TIMEOUT_MS', 5000),
  stateDbMigrationDryRun: optionalBool('STATE_DB_MIGRATION_DRY_RUN', false),
  artifactDir: optional('ARTIFACT_DIR', '/data/artifacts'),

  githubOauthClientId: optional('GITHUB_OAUTH_CLIENT_ID', ''),
  githubOauthClientSecret: optional('GITHUB_OAUTH_CLIENT_SECRET', ''),
  discordOauthClientId: optional('DISCORD_OAUTH_CLIENT_ID', ''),
  discordOauthClientSecret: optional('DISCORD_OAUTH_CLIENT_SECRET', ''),
  discordBotToken: optional('DISCORD_BOT_TOKEN', ''),

  stripeSecretKey: optional('STRIPE_SECRET_KEY', ''),
  stripeWebhookSecret: optional('STRIPE_WEBHOOK_SECRET', ''),
  stripeRegularPriceId: optional('STRIPE_REGULAR_PRICE_ID', ''),
  stripePriorityPriceId: optional('STRIPE_PRIORITY_PRICE_ID', ''),
  stripeApiPriceId: optional('STRIPE_API_PRICE_ID', ''),
  stripePriorityApiPriceId: optional('STRIPE_PRIORITY_API_PRICE_ID', ''),

  cryptoBillingEnabled: optionalBool('CRYPTO_BILLING_ENABLED', false),
  cryptoBillingPollIntervalSeconds: optionalInt('CRYPTO_BILLING_POLL_INTERVAL_SECONDS', 300),
  cryptoDunningGraceHours: optionalInt('CRYPTO_DUNNING_GRACE_HOURS', 72),
  nowpaymentsApiKey: optional('NOWPAYMENTS_API_KEY', ''),
  nowpaymentsIpnSecret: optional('NOWPAYMENTS_IPN_SECRET', ''),
  nowpaymentsIpnSecretPrevious: optional('NOWPAYMENTS_IPN_SECRET_PREVIOUS', ''),
  nowpaymentsApiBaseUrl: optional('NOWPAYMENTS_API_BASE_URL', 'https://api.nowpayments.io/v1'),
  nowpaymentsEnvironment: optional('NOWPAYMENTS_ENVIRONMENT', 'live'),
  nowpaymentsSupportedAssets: optionalList('NOWPAYMENTS_SUPPORTED_ASSETS', 'USDC,USDT').map((value) => value.toUpperCase()),
  nowpaymentsDefaultAsset: optional('NOWPAYMENTS_DEFAULT_ASSET', 'USDC').toUpperCase(),
  nowpaymentsPriceCurrency: optional('NOWPAYMENTS_PRICE_CURRENCY', 'EUR').toUpperCase(),

  ipadecryptBin: optional('IPADECRYPT_BIN', 'ipadecrypt'),
  outputDir: optional('OUTPUT_DIR', '/data/tmp'),
  ipadecryptRootDir: optional('IPADECRYPT_ROOT_DIR', '/root/.ipadecrypt'),
  deviceRuntimeDir: optional('DEVICE_RUNTIME_DIR', '/data/state/device-runtime'),
  deviceSshKeyPath: optional('DEVICE_SSH_KEY_PATH', '/root/.ssh/id_ed25519'),
  deviceSshUser: optional('DEVICE_SSH_USER', 'mobile'),
  deviceSshPort: optionalInt('DEVICE_SSH_PORT', 22),
  deviceTransport: optional('DEVICE_TRANSPORT', 'auto'),
  deviceBridgeSocket: optional('DEVICE_BRIDGE_SOCKET', '/run/dkrypt/device-bridge.sock'),
  deviceBridgeSecret: optional('DEVICE_BRIDGE_SECRET', ''),
  deviceMuxSocket: optional('DEVICE_MUX_SOCKET', '/run/dkrypt/usbmuxd.sock'),
  devicePairingStore: optional('DEVICE_PAIRING_STORE', '/data/state/device-pairing'),
  deviceBridgeHostId: optional('DEVICE_BRIDGE_HOST_ID', ''),
  netmuxdBin: optional('NETMUXD_BIN', '/usr/local/bin/netmuxd'),
  artifactMaxBytes: optionalInt('ARTIFACT_MAX_BYTES', 200 * 1024 * 1024 * 1024),

  jobMaxWaitSeconds: optionalInt('JOB_MAX_WAIT_SECONDS', 1800),
  jobMaxRetries: optionalInt('JOB_MAX_RETRIES', 1),
  jobProcessGraceSeconds: optionalInt('JOB_PROCESS_GRACE_SECONDS', 10),
  jobRetentionMinutes: optionalInt('JOB_RETENTION_MINUTES', 24 * 60),

  watchBundleId: optional('WATCH_BUNDLE_ID', ''),
  watchAppRepo: optional('WATCH_APP_REPO', ''),
  ghDispatchRepo: optional('GH_DISPATCH_REPO', ''),
  ghWorkflowFile: optional('GH_WORKFLOW_FILE', 'remote-ipa-update.yml'),
  ghToken: optional('GH_TOKEN', ''),
  pollCron: optional('POLL_CRON', '0 * * * *'),
  runPollIntervalSeconds: optionalInt('RUN_POLL_INTERVAL_SECONDS', 15),
  runPollTimeoutMinutes: optionalInt('RUN_POLL_TIMEOUT_MINUTES', 30),
  notifyWebhookUrl: optional('NOTIFY_WEBHOOK_URL', ''),
  outboundWebhookSecret: optional('OUTBOUND_WEBHOOK_SECRET', ''),
  userConcurrencyCap: optionalInt('USER_CONCURRENCY_CAP', 0),
  queueSloMinutes: optionalInt('QUEUE_SLO_MINUTES', 30),

  smtpHost: optional('SMTP_HOST', ''),
  smtpPort: optionalInt('SMTP_PORT', 587),
  smtpUser: optional('SMTP_USER', ''),
  smtpPass: optional('SMTP_PASS', ''),
  smtpFrom: optional('SMTP_FROM', 'dkrypt <dkrypt@dylib.dev>'),
};

export const githubOauthEnabled = config.githubOauthClientId !== '' && config.githubOauthClientSecret !== '';
export const discordOauthEnabled = config.discordOauthClientId !== '' && config.discordOauthClientSecret !== '';
export const discordBotEnabled = config.discordBotToken !== '';
export const stripeEnvironment = config.stripeSecretKey.startsWith('sk_live_') || config.stripeSecretKey.startsWith('rk_live_') ? 'live' : 'test';
const stripeRequirements = [
  ['STRIPE_SECRET_KEY', config.stripeSecretKey],
  ['STRIPE_WEBHOOK_SECRET', config.stripeWebhookSecret],
  ['STRIPE_REGULAR_PRICE_ID', config.stripeRegularPriceId],
  ['STRIPE_PRIORITY_PRICE_ID', config.stripePriorityPriceId],
  ['STRIPE_API_PRICE_ID', config.stripeApiPriceId],
  ['STRIPE_PRIORITY_API_PRICE_ID', config.stripePriorityApiPriceId],
] as const;
export const stripeMissingConfiguration = stripeRequirements.filter(([, value]) => value === '').map(([name]) => name);
export const stripeEnabled = stripeMissingConfiguration.length === 0;
export const nowpaymentsEnvironment = config.nowpaymentsEnvironment as 'live' | 'test';
if (config.nowpaymentsEnvironment !== 'live' && config.nowpaymentsEnvironment !== 'test') throw new Error(`env var NOWPAYMENTS_ENVIRONMENT must be live or test, got ${config.nowpaymentsEnvironment}`);
const nowpaymentsRequirements = [
  ['NOWPAYMENTS_API_KEY', config.nowpaymentsApiKey],
  ['NOWPAYMENTS_IPN_SECRET', config.nowpaymentsIpnSecret],
  ['NOWPAYMENTS_API_BASE_URL', config.nowpaymentsApiBaseUrl],
  ['NOWPAYMENTS_PRICE_CURRENCY', config.nowpaymentsPriceCurrency],
] as const;
export const nowpaymentsMissingConfiguration = nowpaymentsRequirements
  .filter(([, value]) => value === '')
  .map(([name]) => name);
export const nowpaymentsConfigured = nowpaymentsMissingConfiguration.length === 0;
export const cryptoBillingEnabled = config.cryptoBillingEnabled && nowpaymentsConfigured;
export const emailEnabled = config.smtpHost !== '' && config.smtpUser !== '' && config.smtpPass !== '';
