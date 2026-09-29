import type { Database } from 'bun:sqlite';
import type { AllowedUser, Role } from '#store/state.js';
import { replaceStateCollections, type StateCollectionReplacement } from '#store/sqlite.js';

export interface AccountRepository {
  listUsers(): AllowedUser[];
  findUser(username: string): AllowedUser | undefined;
  hasCanonicalUserKeys(): boolean;
  listRoles(): Role[];
  findRole(roleId: string): Role | undefined;
  collectionReplacements(users: AllowedUser[], roles: Role[]): StateCollectionReplacement[];
  replaceAll(users: AllowedUser[], roles: Role[]): void;
}

export function isUserMfaRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const mfa = value as Record<string, unknown>;
  return typeof mfa.enabled === 'boolean'
    && (mfa.secretCiphertext === undefined || typeof mfa.secretCiphertext === 'string')
    && (mfa.pendingSecretCiphertext === undefined || typeof mfa.pendingSecretCiphertext === 'string')
    && (mfa.recoveryCodeHashes === undefined || (Array.isArray(mfa.recoveryCodeHashes) && mfa.recoveryCodeHashes.every((hash) => typeof hash === 'string')))
    && (mfa.updatedAt === undefined || typeof mfa.updatedAt === 'number');
}

export function isAllowedUserRecord(value: unknown): value is AllowedUser {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const user = value as Record<string, unknown>;
  return typeof user.username === 'string'
    && typeof user.addedAt === 'number'
    && Array.isArray(user.roleIds)
    && user.roleIds.every((roleId) => typeof roleId === 'string')
    && (user.sessionVersion === undefined || typeof user.sessionVersion === 'number')
    && (user.lastActiveAt === undefined || typeof user.lastActiveAt === 'number')
    && (user.priority === undefined || typeof user.priority === 'number')
    && (user.discordPerkRoleIds === undefined || (Array.isArray(user.discordPerkRoleIds) && user.discordPerkRoleIds.every((roleId) => typeof roleId === 'string')))
    && (user.mfa === undefined || isUserMfaRecord(user.mfa));
}

export function isRoleRecord(value: unknown): value is Role {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const role = value as Record<string, unknown>;
  return typeof role.id === 'string'
    && typeof role.name === 'string'
    && typeof role.color === 'string'
    && typeof role.permissions === 'string'
    && typeof role.position === 'number'
    && typeof role.isDefault === 'boolean'
    && (role.createdAt === undefined || typeof role.createdAt === 'number')
    && (role.updatedAt === undefined || typeof role.updatedAt === 'number');
}

function normalizeUser(user: AllowedUser): AllowedUser {
  const normalized = structuredClone(user);
  normalized.username = normalized.username.toLowerCase();
  return normalized;
}

function parseUser(payload: unknown): AllowedUser {
  if (!isAllowedUserRecord(payload)) throw new Error('persisted account record is malformed');
  return normalizeUser(payload);
}

function parseRole(payload: unknown): Role {
  if (!isRoleRecord(payload)) throw new Error('persisted role record is malformed');
  return structuredClone(payload);
}

function normalizedCollections(users: AllowedUser[], roles: Role[]): { users: AllowedUser[]; roles: Role[] } {
  if (!users.every(isAllowedUserRecord)) throw new Error('account records are malformed');
  if (!roles.every(isRoleRecord)) throw new Error('role records are malformed');
  const normalizedUsers = users.map(normalizeUser);
  if (new Set(normalizedUsers.map((user) => user.username)).size !== normalizedUsers.length) throw new Error('account usernames must be unique ignoring case');
  if (new Set(roles.map((role) => role.id)).size !== roles.length) throw new Error('role ids must be unique');
  if (roles.filter((role) => role.isDefault).length !== 1) throw new Error('exactly one default role is required');
  return { users: normalizedUsers, roles: roles.map((role) => structuredClone(role)) };
}

export function createAccountRepository(database: Database): AccountRepository {
  const listUsersQuery = database.query('SELECT id, payload FROM users ORDER BY rowid ASC;');
  const findUserQuery = database.query('SELECT payload FROM users WHERE id = ?;');
  const listRolesQuery = database.query('SELECT id, payload FROM roles ORDER BY rowid ASC;');
  const findRoleQuery = database.query('SELECT id, payload FROM roles WHERE id = ?;');

  function listUsers(): AllowedUser[] {
    return (listUsersQuery.all() as Array<{ id: string; payload: string }>).map(({ payload }) => parseUser(JSON.parse(payload) as unknown));
  }

  function hasCanonicalUserKeys(): boolean {
    return (listUsersQuery.all() as Array<{ id: string; payload: string }>).every(({ id, payload }) => {
      const user = parseUser(JSON.parse(payload) as unknown);
      return id === user.username;
    });
  }

  function listRoles(): Role[] {
    return (listRolesQuery.all() as Array<{ id: string; payload: string }>).map(({ id, payload }) => {
      const role = parseRole(JSON.parse(payload) as unknown);
      if (role.id !== id) throw new Error('persisted role key does not match its record');
      return role;
    });
  }

  function collectionReplacements(users: AllowedUser[], roles: Role[]): StateCollectionReplacement[] {
    const normalized = normalizedCollections(users, roles);
    return [
      {
        table: 'users',
        rows: normalized.users.map((user) => ({ id: user.username, payload: user, updatedAt: user.lastActiveAt ?? user.addedAt })),
      },
      {
        table: 'roles',
        rows: normalized.roles.map((role) => ({ id: role.id, payload: role, updatedAt: role.updatedAt ?? role.createdAt ?? 0 })),
      },
    ];
  }

  return {
    listUsers,
    findUser(username) {
      const normalized = username.toLowerCase();
      const row = findUserQuery.get(normalized) as { payload: string } | null;
      if (row) return parseUser(JSON.parse(row.payload) as unknown);
      return listUsers().find((user) => user.username === normalized);
    },
    hasCanonicalUserKeys,
    listRoles,
    findRole(roleId) {
      const row = findRoleQuery.get(roleId) as { id: string; payload: string } | null;
      if (!row) return undefined;
      const role = parseRole(JSON.parse(row.payload) as unknown);
      if (role.id !== row.id) throw new Error('persisted role key does not match its record');
      return role;
    },
    collectionReplacements,
    replaceAll(users, roles) {
      replaceStateCollections(database, collectionReplacements(users, roles));
    },
  };
}
