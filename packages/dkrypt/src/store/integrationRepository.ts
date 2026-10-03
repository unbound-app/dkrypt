import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from '#config.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';

export interface SignedTriggerPolicy {
  id: string;
  kind: 'signed_decrypt';
  projectId: string;
  bundleIds: string[];
  sources: Array<'appstore' | 'testflight'>;
  enabled: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  secret: string;
  previousSecret?: string;
  previousSecretExpiresAt?: number;
}

export interface GithubOidcPolicy {
  id: string;
  kind: 'github_oidc';
  repositoryId: string;
  workflowRef: string;
  ref?: string;
  environment?: string;
  audience: string;
  projectId: string;
  bundleIds: string[];
  allowTestFlight: boolean;
  enabled: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface IntegrationDelivery {
  id: string;
  integrationId: string;
  eventId: string;
  at: number;
  status: 'processing' | 'accepted' | 'failed';
  jobId?: string;
}

const database = openStateCollectionDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs }, ['integration_policies', 'integration_deliveries']);
const signatureWindowMs = 5 * 60_000;

export function publicSignedTriggerPolicy(policy: SignedTriggerPolicy): Omit<SignedTriggerPolicy, 'secret' | 'previousSecret'> {
  const { secret: _secret, previousSecret: _previousSecret, ...safe } = policy;
  return safe;
}

export function getSignedTriggerPolicy(id: string): SignedTriggerPolicy | undefined {
  const row = database.query('SELECT payload FROM integration_policies WHERE id = ? AND kind = ?').get(id, 'signed_decrypt') as { payload: string } | null;
  return row ? JSON.parse(row.payload) as SignedTriggerPolicy : undefined;
}

export function listSignedTriggerPolicies(): Array<ReturnType<typeof publicSignedTriggerPolicy>> {
  const rows = database.query('SELECT payload FROM integration_policies WHERE kind = ? ORDER BY updated_at DESC').all('signed_decrypt') as Array<{ payload: string }>;
  return rows.map((row) => publicSignedTriggerPolicy(JSON.parse(row.payload) as SignedTriggerPolicy));
}

function persist(policy: SignedTriggerPolicy): void {
  database.query('INSERT INTO integration_policies (id, payload, updated_at, kind, project_id, enabled) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at, enabled = excluded.enabled').run(policy.id, JSON.stringify(policy), policy.updatedAt, policy.kind, policy.projectId, policy.enabled ? 1 : 0);
}

export function createSignedTriggerPolicy(input: Pick<SignedTriggerPolicy, 'projectId' | 'bundleIds' | 'sources' | 'createdBy'>): SignedTriggerPolicy {
  const now = Date.now();
  const policy: SignedTriggerPolicy = { ...input, kind: 'signed_decrypt', id: randomUUID(), enabled: true, secret: randomBytes(32).toString('hex'), createdAt: now, updatedAt: now };
  persist(policy);
  return policy;
}

export function rotateSignedTriggerSecret(id: string): SignedTriggerPolicy | undefined {
  const policy = getSignedTriggerPolicy(id);
  if (!policy || !policy.enabled) return undefined;
  policy.previousSecret = policy.secret;
  policy.previousSecretExpiresAt = Date.now() + 10 * 60_000;
  policy.secret = randomBytes(32).toString('hex');
  policy.updatedAt = Date.now();
  persist(policy);
  return policy;
}

export function revokeSignedTriggerPolicy(id: string): boolean {
  const policy = getSignedTriggerPolicy(id);
  if (!policy || !policy.enabled) return false;
  policy.enabled = false;
  policy.previousSecret = undefined;
  policy.updatedAt = Date.now();
  persist(policy);
  return true;
}

export function verifySignedTrigger(policy: SignedTriggerPolicy, timestamp: string, eventId: string, signature: string, rawBody: Buffer, now = Date.now()): boolean {
  if (!policy.enabled || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > signatureWindowMs || !/^[A-Za-z0-9._:-]{1,200}$/.test(eventId) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const payload = Buffer.concat([Buffer.from(`${timestamp}.${eventId}.`), rawBody]);
  const secrets = [policy.secret, ...(policy.previousSecret && policy.previousSecretExpiresAt && policy.previousSecretExpiresAt > now ? [policy.previousSecret] : [])];
  return secrets.some((secret) => timingSafeEqual(Buffer.from(createHmac('sha256', secret).update(payload).digest('hex')), Buffer.from(signature)));
}

export function reserveIntegrationDelivery(integrationId: string, eventId: string): IntegrationDelivery | undefined {
  const at = Date.now();
  const delivery: IntegrationDelivery = { id: randomUUID(), integrationId, eventId, at, status: 'processing' };
  const result = database.query('INSERT OR IGNORE INTO integration_deliveries (id, payload, updated_at, integration_id, event_id) VALUES (?, ?, ?, ?, ?)').run(delivery.id, JSON.stringify(delivery), at, integrationId, eventId);
  return result.changes > 0 ? delivery : undefined;
}

export function getIntegrationDelivery(integrationId: string, eventId: string): IntegrationDelivery | undefined {
  const row = database.query('SELECT payload FROM integration_deliveries WHERE integration_id = ? AND event_id = ?').get(integrationId, eventId) as { payload: string } | null;
  return row ? JSON.parse(row.payload) as IntegrationDelivery : undefined;
}

export function finishIntegrationDelivery(delivery: IntegrationDelivery, status: 'accepted' | 'failed', jobId?: string): void {
  const updated = { ...delivery, status, jobId };
  database.query('UPDATE integration_deliveries SET payload = ?, updated_at = ? WHERE id = ? AND payload = ?').run(JSON.stringify(updated), Date.now(), delivery.id, JSON.stringify(delivery));
}

export function closeIntegrationRepository(): void {
  database.close();
}

export function listGithubOidcPolicies(): GithubOidcPolicy[] {
  const rows = database.query('SELECT payload FROM integration_policies WHERE kind = ? ORDER BY updated_at DESC').all('github_oidc') as Array<{ payload: string }>;
  return rows.map((row) => JSON.parse(row.payload) as GithubOidcPolicy);
}

export function createGithubOidcPolicy(input: Omit<GithubOidcPolicy, 'id' | 'kind' | 'enabled' | 'createdAt' | 'updatedAt'>): GithubOidcPolicy {
  const at = Date.now();
  const policy: GithubOidcPolicy = { ...input, id: randomUUID(), kind: 'github_oidc', enabled: true, createdAt: at, updatedAt: at };
  database.query('INSERT INTO integration_policies (id, payload, updated_at, kind, project_id, enabled) VALUES (?, ?, ?, ?, ?, ?)').run(policy.id, JSON.stringify(policy), at, policy.kind, policy.projectId, 1);
  return policy;
}

export function revokeGithubOidcPolicy(id: string): boolean {
  const policy = listGithubOidcPolicies().find((entry) => entry.id === id && entry.enabled);
  if (!policy) return false;
  policy.enabled = false;
  policy.updatedAt = Date.now();
  database.query('UPDATE integration_policies SET payload = ?, updated_at = ?, enabled = 0 WHERE id = ?').run(JSON.stringify(policy), policy.updatedAt, id);
  return true;
}
