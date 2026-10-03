import { mergeBillingAccounts } from '#billing.js';
import {
  type AuthIdentity,
  type AuthProfile,
  findAuthProfileByIdentity,
  mergeAuthProfiles,
  upsertAuthIdentity,
} from '#identity.js';
import { mergeActiveJobOwner } from '#jobs/store.js';
import { mergeUserAccounts } from '#store/state.js';

export interface ResolveOauthAccountInput {
  identity: AuthIdentity;
  discoveredIdentities?: AuthIdentity[];
  fallbackUserId: string;
}

function mergeProfileData(targetUserId: string, sourceUserId: string, actor: string): void {
  if (targetUserId === sourceUserId) return;
  mergeUserAccounts(targetUserId, sourceUserId, actor);
  mergeBillingAccounts(targetUserId, sourceUserId);
  mergeActiveJobOwner(targetUserId, sourceUserId);
  mergeAuthProfiles(targetUserId, sourceUserId);
}

export function resolveOauthAccount(input: ResolveOauthAccountInput): AuthProfile {
  const primaryProfile = findAuthProfileByIdentity(input.identity.provider, input.identity.providerId);
  const targetUserId = primaryProfile?.userId ?? input.fallbackUserId;

  const profile = upsertAuthIdentity(targetUserId, input.identity);
  return profile;
}

export function linkOauthAccount(targetUserId: string, identity: AuthIdentity): AuthProfile {
  const existingProfile = findAuthProfileByIdentity(identity.provider, identity.providerId);
  if (existingProfile && existingProfile.userId !== targetUserId) {
    mergeProfileData(targetUserId, existingProfile.userId, `oauth:${identity.provider}:connect`);
  }
  return upsertAuthIdentity(targetUserId, identity);
}
