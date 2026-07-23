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

const paddleEnvironment = optional('PADDLE_ENV', 'sandbox');

export const config = {
  port: optionalInt('PORT', 8080),
  bindHost: optional('BIND_HOST', '127.0.0.1'),

  apiKey: required('API_KEY'),
  downloadSigningSecret: required('DOWNLOAD_SIGNING_SECRET'),
  publicBaseUrl: optional('PUBLIC_BASE_URL', 'http://localhost:8080'),

  adminPassword: required('ADMIN_PASSWORD'),
  stateDir: optional('STATE_DIR', '/data/state'),

  githubOauthClientId: optional('GITHUB_OAUTH_CLIENT_ID', ''),
  githubOauthClientSecret: optional('GITHUB_OAUTH_CLIENT_SECRET', ''),
  discordOauthClientId: optional('DISCORD_OAUTH_CLIENT_ID', ''),
  discordOauthClientSecret: optional('DISCORD_OAUTH_CLIENT_SECRET', ''),

  paddleEnvironment,
  paddleApiKey: optional(
    'PADDLE_API_KEY',
    optional(paddleEnvironment === 'production' ? 'PADDLE_LIVE_API_KEY' : 'PADDLE_SANDBOX_API_KEY', ''),
  ),
  paddleClientToken: optional(
    'PADDLE_CLIENT_TOKEN',
    paddleEnvironment === 'sandbox' ? 'test_929a0f86f31a93f2db87364231f' : '',
  ),
  paddleWebhookSecret: optional('PADDLE_WEBHOOK_SECRET', ''),
  paddleRegularPriceId: optional(
    'PADDLE_REGULAR_PRICE_ID',
    paddleEnvironment === 'sandbox' ? 'pri_01ky77t7x5111gkpmyp9626s74' : '',
  ),
  paddlePriorityPriceId: optional(
    'PADDLE_PRIORITY_PRICE_ID',
    paddleEnvironment === 'sandbox' ? 'pri_01ky77t8gy88z082pan4jst041' : '',
  ),
  paddleApiPriceId: optional(
    'PADDLE_API_PRICE_ID',
    paddleEnvironment === 'sandbox' ? 'pri_01ky77t9ae7k5b2sgsmxxpb2fx' : '',
  ),
  paddlePriorityApiPriceId: optional(
    'PADDLE_PRIORITY_API_PRICE_ID',
    paddleEnvironment === 'sandbox' ? 'pri_01ky77t9ynrhz0je61qwvm15rg' : '',
  ),

  ipadecryptBin: optional('IPADECRYPT_BIN', 'ipadecrypt'),
  outputDir: optional('OUTPUT_DIR', '/data/tmp'),
  ipadecryptRootDir: optional('IPADECRYPT_ROOT_DIR', '/root/.ipadecrypt'),

  jobMaxWaitSeconds: optionalInt('JOB_MAX_WAIT_SECONDS', 1800),
  fileTtlMinutes: optionalInt('FILE_TTL_MINUTES', 15),
  jobRetentionMinutes: optionalInt('JOB_RETENTION_MINUTES', 60),

  watchBundleId: optional('WATCH_BUNDLE_ID', ''),
  watchAppRepo: optional('WATCH_APP_REPO', ''),
  ghDispatchRepo: optional('GH_DISPATCH_REPO', ''),
  ghWorkflowFile: optional('GH_WORKFLOW_FILE', 'remote-ipa-update.yml'),
  ghToken: optional('GH_TOKEN', ''),
  pollCron: optional('POLL_CRON', '0 * * * *'),
  runPollIntervalSeconds: optionalInt('RUN_POLL_INTERVAL_SECONDS', 15),
  runPollTimeoutMinutes: optionalInt('RUN_POLL_TIMEOUT_MINUTES', 30),
  notifyWebhookUrl: optional('NOTIFY_WEBHOOK_URL', ''),
  userConcurrencyCap: optionalInt('USER_CONCURRENCY_CAP', 0),
};

export const githubOauthEnabled = config.githubOauthClientId !== '' && config.githubOauthClientSecret !== '';
export const discordOauthEnabled = config.discordOauthClientId !== '' && config.discordOauthClientSecret !== '';
export const paddleEnabled =
  config.paddleClientToken !== '' &&
  config.paddleRegularPriceId !== '' &&
  config.paddlePriorityPriceId !== '' &&
  config.paddleApiPriceId !== '' &&
  config.paddlePriorityApiPriceId !== '';
