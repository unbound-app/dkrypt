import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export type Role = 'admin' | 'member';
export type ApiKeyStatus = 'pending' | 'approved' | 'denied';

export interface AllowedUser {
  username: string; // lowercase github login
  role: Role;
  addedAt: number;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  ownerId: string; // 'root' or a github username
  status: ApiKeyStatus;
  hash?: string;
  /** Plaintext secret, present only between approval/regeneration and the owner's first reveal. */
  pendingReveal?: string;
  createdAt: number;
  approvedAt?: number;
  lastUsedAt?: number;
}

export interface SchedulerSettings {
  watchBundleId: string;
  watchAppRepo: string;
  ghDispatchRepo: string;
  ghWorkflowFile: string;
  pollCron: string;
  notifyWebhookUrl: string;
}

export interface JobHistoryEntry {
  id: string;
  bundleId: string;
  status: 'done' | 'failed';
  error?: string;
  sizeBytes?: number;
  source: 'manual' | 'scheduler';
  createdAt: number;
  finishedAt: number;
}

interface AppleAuthAlert {
  suspected: boolean;
  lastError?: string;
  lastErrorAt?: number;
}

interface PersistedState {
  version: 2;
  apiKeys: ApiKeyRecord[];
  allowedUsers: AllowedUser[];
  settings: Partial<SchedulerSettings>;
  jobHistory: JobHistoryEntry[];
  appleAuthAlert: AppleAuthAlert;
}

const MAX_HISTORY = 100;
const statePath = path.join(config.stateDir, 'state.json');

function defaultState(): PersistedState {
  return {
    version: 2,
    apiKeys: [],
    allowedUsers: [],
    settings: {},
    jobHistory: [],
    appleAuthAlert: { suspected: false },
  };
}

/** v1 state had every key already hash-bearing and implicitly admin-created/approved. */
function migrate(raw: Record<string, unknown>): PersistedState {
  if (raw.version === 2) return { ...defaultState(), ...raw } as PersistedState;

  const legacyKeys = Array.isArray(raw.apiKeys) ? (raw.apiKeys as Record<string, unknown>[]) : [];
  return {
    ...defaultState(),
    apiKeys: legacyKeys.map((k) => ({
      id: k.id as string,
      name: k.name as string,
      ownerId: 'root',
      status: 'approved',
      hash: k.hash as string,
      createdAt: k.createdAt as number,
      approvedAt: k.createdAt as number,
      lastUsedAt: k.lastUsedAt as number | undefined,
    })),
    settings: (raw.settings as Partial<SchedulerSettings>) ?? {},
    jobHistory: (raw.jobHistory as JobHistoryEntry[]) ?? [],
    appleAuthAlert: (raw.appleAuthAlert as AppleAuthAlert) ?? { suspected: false },
  };
}

function load(): PersistedState {
  mkdirSync(config.stateDir, { recursive: true });
  if (!existsSync(statePath)) return defaultState();
  try {
    return migrate(JSON.parse(readFileSync(statePath, 'utf8')));
  } catch {
    return defaultState();
  }
}

const state: PersistedState = load();
let dirty = false;

function persistNow(): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  dirty = false;
}

/** Periodic flush for low-value writes (e.g. API key lastUsedAt) that don't need to hit disk immediately. */
export function startStateFlusher(): void {
  setInterval(() => {
    if (dirty) persistNow();
  }, 30_000).unref();
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// --- allowed users (github oauth allowlist) ---

export function listAllowedUsers(): AllowedUser[] {
  return state.allowedUsers;
}

export function getUserRole(username: string): Role | undefined {
  return state.allowedUsers.find((u) => u.username === username.toLowerCase())?.role;
}

export function addAllowedUser(username: string, role: Role): AllowedUser {
  const lower = username.toLowerCase();
  const existing = state.allowedUsers.find((u) => u.username === lower);
  if (existing) {
    existing.role = role;
    persistNow();
    return existing;
  }
  const record: AllowedUser = { username: lower, role, addedAt: Date.now() };
  state.allowedUsers.push(record);
  persistNow();
  return record;
}

export function removeAllowedUser(username: string): boolean {
  const before = state.allowedUsers.length;
  state.allowedUsers = state.allowedUsers.filter((u) => u.username !== username.toLowerCase());
  const changed = state.allowedUsers.length !== before;
  if (changed) persistNow();
  return changed;
}

// --- api keys ---

function redact(k: ApiKeyRecord) {
  return {
    id: k.id,
    name: k.name,
    ownerId: k.ownerId,
    status: k.status,
    createdAt: k.createdAt,
    approvedAt: k.approvedAt,
    lastUsedAt: k.lastUsedAt,
    hasUnrevealedSecret: !!k.pendingReveal,
  };
}

/** Admin (or a service account) creating a key directly - auto-approved, no request/approve step. */
export function createApiKey(name: string, ownerId: string): { id: string; name: string; key: string; createdAt: number } {
  const key = randomBytes(32).toString('hex');
  const record: ApiKeyRecord = {
    id: randomUUID(),
    name,
    ownerId,
    status: 'approved',
    hash: hashKey(key),
    pendingReveal: key,
    createdAt: Date.now(),
    approvedAt: Date.now(),
  };
  state.apiKeys.push(record);
  persistNow();
  return { id: record.id, name: record.name, key, createdAt: record.createdAt };
}

/** A member requesting a new key - lands as 'pending' until an admin approves it. */
export function requestApiKey(name: string, ownerId: string) {
  const record: ApiKeyRecord = { id: randomUUID(), name, ownerId, status: 'pending', createdAt: Date.now() };
  state.apiKeys.push(record);
  persistNow();
  return redact(record);
}

export function approveApiKey(id: string): boolean {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record || record.status !== 'pending') return false;
  const key = randomBytes(32).toString('hex');
  record.status = 'approved';
  record.hash = hashKey(key);
  record.pendingReveal = key;
  record.approvedAt = Date.now();
  persistNow();
  return true;
}

export function denyApiKey(id: string): boolean {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record || record.status !== 'pending') return false;
  record.status = 'denied';
  persistNow();
  return true;
}

/** Only the owner of an already-approved key may regenerate its secret. */
export function regenerateApiKey(id: string, requesterId: string): boolean {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record || record.status !== 'approved' || record.ownerId !== requesterId) return false;
  const key = randomBytes(32).toString('hex');
  record.hash = hashKey(key);
  record.pendingReveal = key;
  persistNow();
  return true;
}

/** Reveals (and clears) the pending plaintext secret - only the owner can call this. */
export function revealApiKeySecret(id: string, requesterId: string): string | undefined {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record || record.ownerId !== requesterId || !record.pendingReveal) return undefined;
  const secret = record.pendingReveal;
  record.pendingReveal = undefined;
  persistNow();
  return secret;
}

export function listApiKeysForOwner(ownerId: string) {
  return state.apiKeys.filter((k) => k.ownerId === ownerId).map(redact);
}

export function listAllApiKeys() {
  return state.apiKeys.map(redact);
}

export function listPendingApiKeys() {
  return state.apiKeys.filter((k) => k.status === 'pending').map(redact);
}

/** Owner or an admin may revoke (delete) a key outright. */
export function revokeApiKey(id: string, requesterId: string, requesterIsAdmin: boolean): boolean {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record) return false;
  if (!requesterIsAdmin && record.ownerId !== requesterId) return false;

  state.apiKeys = state.apiKeys.filter((k) => k.id !== id);
  persistNow();
  return true;
}

/** True if `candidate` is the permanent root API_KEY or a live, approved issued key. */
export function verifyApiKey(candidate: string): boolean {
  if (safeEqualStr(candidate, config.apiKey)) return true;

  const hash = hashKey(candidate);
  const record = state.apiKeys.find((k) => k.status === 'approved' && k.hash === hash);
  if (!record) return false;

  record.lastUsedAt = Date.now();
  dirty = true;
  return true;
}

// --- scheduler settings (dashboard-editable overlay on top of env defaults) ---

export function getEffectiveSettings(): SchedulerSettings {
  return {
    watchBundleId: state.settings.watchBundleId ?? config.watchBundleId,
    watchAppRepo: state.settings.watchAppRepo ?? config.watchAppRepo,
    ghDispatchRepo: state.settings.ghDispatchRepo ?? config.ghDispatchRepo,
    ghWorkflowFile: state.settings.ghWorkflowFile ?? config.ghWorkflowFile,
    pollCron: state.settings.pollCron ?? config.pollCron,
    notifyWebhookUrl: state.settings.notifyWebhookUrl ?? config.notifyWebhookUrl,
  };
}

export function updateSettings(patch: Partial<SchedulerSettings>): SchedulerSettings {
  state.settings = { ...state.settings, ...patch };
  persistNow();
  return getEffectiveSettings();
}

export function isSchedulerEnabled(): boolean {
  const s = getEffectiveSettings();
  return s.watchBundleId !== '' && s.watchAppRepo !== '' && s.ghDispatchRepo !== '' && config.ghToken !== '';
}

// --- job history ---

export function recordJobHistory(entry: JobHistoryEntry): void {
  state.jobHistory.unshift(entry);
  if (state.jobHistory.length > MAX_HISTORY) state.jobHistory.length = MAX_HISTORY;
  persistNow();
}

export function getJobHistory(): JobHistoryEntry[] {
  return state.jobHistory;
}

// --- apple auth alert ---

export function getAppleAuthAlert(): AppleAuthAlert {
  return state.appleAuthAlert;
}

export function setAppleAuthAlert(error: string): void {
  state.appleAuthAlert = { suspected: true, lastError: error, lastErrorAt: Date.now() };
  persistNow();
}

export function clearAppleAuthAlert(): void {
  if (!state.appleAuthAlert.suspected) return;
  state.appleAuthAlert = { suspected: false };
  persistNow();
}
