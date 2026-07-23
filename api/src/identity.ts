import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export type AuthProvider = 'github' | 'discord';

export interface AuthProfile {
  userId: string;
  provider: AuthProvider;
  providerId: string;
  username: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
  updatedAt: string;
}

export interface IdentitySnapshot {
  profiles: AuthProfile[];
}

const identityPath = path.join(config.stateDir, 'identities.json');

function load(): IdentitySnapshot {
  mkdirSync(config.stateDir, { recursive: true });
  if (!existsSync(identityPath)) return { profiles: [] };
  try {
    const parsed = JSON.parse(readFileSync(identityPath, 'utf8')) as Partial<IdentitySnapshot>;
    return { profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [] };
  } catch {
    return { profiles: [] };
  }
}

const state = load();

export function upsertAuthProfile(profile: AuthProfile): AuthProfile {
  const existing = state.profiles.find((item) => item.userId === profile.userId);
  if (existing) Object.assign(existing, profile);
  else state.profiles.push(profile);
  writeFileSync(identityPath, JSON.stringify(state, null, 2));
  return existing ?? profile;
}

export function getAuthProfile(userId: string): AuthProfile | undefined {
  return state.profiles.find((profile) => profile.userId === userId);
}

export function exportIdentitySnapshot(): IdentitySnapshot {
  return structuredClone(state);
}

export function isIdentitySnapshot(value: unknown): value is IdentitySnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const profiles = (value as Record<string, unknown>).profiles;
  return (
    Array.isArray(profiles) &&
    profiles.every((profile) => {
      if (typeof profile !== 'object' || profile === null) return false;
      const record = profile as Record<string, unknown>;
      return (
        typeof record.userId === 'string' &&
        (record.provider === 'github' || record.provider === 'discord') &&
        typeof record.providerId === 'string' &&
        typeof record.username === 'string' &&
        typeof record.displayName === 'string' &&
        typeof record.updatedAt === 'string'
      );
    })
  );
}

export function replaceIdentitySnapshot(snapshot: IdentitySnapshot): void {
  state.profiles = structuredClone(snapshot.profiles);
  writeFileSync(identityPath, JSON.stringify(state, null, 2));
}
