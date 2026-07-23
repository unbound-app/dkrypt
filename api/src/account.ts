import { mergeBillingAccounts } from './billing.js';
import {
  type AuthIdentity,
  type AuthProfile,
  findAuthProfileByIdentity,
  getAuthProfile,
  mergeAuthProfiles,
  upsertAuthIdentity,
} from './identity.js';
import { mergeActiveJobOwner } from './jobs/store.js';
import { listAllowedUsers, mergeUserAccounts } from './store/state.js';

export interface ResolveOauthAccountInput {
  identity: AuthIdentity;
  discoveredIdentities?: AuthIdentity[];
  fallbackUserId: string;
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
    mergeUserAccounts(targetUserId, profile.userId, `oauth:${input.identity.provider}`);
    mergeBillingAccounts(targetUserId, profile.userId);
    mergeActiveJobOwner(targetUserId, profile.userId);
    mergeAuthProfiles(targetUserId, profile.userId);
  }

  const profile = upsertAuthIdentity(targetUserId, input.identity);
  for (const identity of discoveredIdentities) upsertAuthIdentity(targetUserId, identity);
  return profile;
}
