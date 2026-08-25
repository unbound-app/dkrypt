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

const DEFAULT_TTL_MINUTES = 24 * 60;

export const config = {
  port: optionalInt('PORT', 8080),
  bindHost: optional('BIND_HOST', '127.0.0.1'),

  apiKey: required('API_KEY'),
  downloadSigningSecret: required('DOWNLOAD_SIGNING_SECRET'),
  publicBaseUrl: optional('PUBLIC_BASE_URL', 'http://localhost:8080'),

  adminPassword: required('ADMIN_PASSWORD'),
  stateDir: optional('STATE_DIR', '/data/state'),
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

  ipadecryptBin: optional('IPADECRYPT_BIN', 'ipadecrypt'),
  outputDir: optional('OUTPUT_DIR', '/data/tmp'),
  ipadecryptRootDir: optional('IPADECRYPT_ROOT_DIR', '/root/.ipadecrypt'),
  artifactMaxBytes: optionalInt('ARTIFACT_MAX_BYTES', 200 * 1024 * 1024 * 1024),

  jobMaxWaitSeconds: optionalInt('JOB_MAX_WAIT_SECONDS', 1800),
  fileTtlMinutes: optionalInt('FILE_TTL_MINUTES', DEFAULT_TTL_MINUTES),
  jobRetentionMinutes: optionalInt('JOB_RETENTION_MINUTES', DEFAULT_TTL_MINUTES),

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
export const emailEnabled = config.smtpHost !== '' && config.smtpUser !== '' && config.smtpPass !== '';
