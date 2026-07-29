import { mergeBillingAccounts } from '#billing.js';
import {
  type AuthIdentity,
  type AuthProfile,
  findAuthProfileByIdentity,
  getAuthProfile,
  mergeAuthProfiles,
  upsertAuthIdentity,
} from '#identity.js';
import { mergeActiveJobOwner } from '#jobs/store.js';
import { listAllowedUsers, mergeUserAccounts } from '#store/state.js';

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

function uniqueProfiles(profiles: Array<AuthProfile | undefined>): AuthProfile[] {
  return profiles.filter(
    (profile, index, all): profile is AuthProfile =>
      !!profile && all.findIndex((candidate) => candidate?.userId === profile.userId) === index,
  );
}

function findLegacyGithubUserId(identities: AuthIdentity[]): string | undefined {
  const allowedUsers = listAllowedUsers();
  for (const identity of identities) {
    if (identity.provider !== 'github') continue;
    const userId = identity.username.toLowerCase();
    if (allowedUsers.some((user) => user.username === userId) && !getAuthProfile(userId)) return userId;
  }
  return undefined;
}

export function resolveOauthAccount(input: ResolveOauthAccountInput): AuthProfile {
  const discoveredIdentities = input.discoveredIdentities ?? [];
  const primaryProfile = findAuthProfileByIdentity(input.identity.provider, input.identity.providerId);
  const discoveredProfiles = uniqueProfiles(
    discoveredIdentities.map((identity) => findAuthProfileByIdentity(identity.provider, identity.providerId)),
  );
  const connectedGithubProfile =
    input.identity.provider === 'discord'
      ? discoveredProfiles.find((profile) =>
          profile.identities?.some((identity) => identity.provider === 'github' && identity.source === 'oauth'),
        ) ?? discoveredProfiles[0]
      : undefined;
  const targetProfile = connectedGithubProfile ?? primaryProfile ?? discoveredProfiles[0];
  const legacyGithubUserId = findLegacyGithubUserId([input.identity, ...discoveredIdentities]);
  const fallbackLegacyAccountExists =
    listAllowedUsers().some((user) => user.username === input.fallbackUserId.toLowerCase()) && !getAuthProfile(input.fallbackUserId);
  const targetUserId =
    legacyGithubUserId ??
    (fallbackLegacyAccountExists ? input.fallbackUserId : (targetProfile?.userId ?? input.fallbackUserId));

  const profilesToMerge = uniqueProfiles([primaryProfile, ...discoveredProfiles]).filter(
    (profile) => profile.userId !== targetUserId,
  );
  for (const profile of profilesToMerge) {
    mergeProfileData(targetUserId, profile.userId, `oauth:${input.identity.provider}`);
  }

  const profile = upsertAuthIdentity(targetUserId, input.identity);
  for (const identity of discoveredIdentities) upsertAuthIdentity(targetUserId, identity);
  return profile;
}

export function linkOauthAccount(targetUserId: string, identity: AuthIdentity): AuthProfile {
  const existingProfile = findAuthProfileByIdentity(identity.provider, identity.providerId);
  if (existingProfile && existingProfile.userId !== targetUserId) {
    mergeProfileData(targetUserId, existingProfile.userId, `oauth:${identity.provider}:connect`);
  }
  return upsertAuthIdentity(targetUserId, identity);
}
