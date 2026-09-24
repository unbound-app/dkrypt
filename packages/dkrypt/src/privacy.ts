import { anonymizeBillingUser, getBillingSubscriptionsForUser, hasActiveBillingSubscription, listBillingEntitlementHistory } from '#billing.js';
import { deleteAuthProfile, getAuthProfile, getLinkedAuthIdentities } from '#identity.js';
import { mfaStatus } from '#mfa.js';
import {
  deleteUserPersonalData,
  getUserActivityStats,
  getUserJobHistory,
  getUserPrefs,
  listApiKeysForOwner,
  listPasskeysForUser,
  listSessionsForUser,
  listTestFlightSubscriptionsForUser,
  recordAudit,
} from '#store/state.js';

export interface AccountExport {
  exportedAt: string;
  account: {
    userId: string;
    displayName?: string;
    email?: string;
    identities: ReturnType<typeof getLinkedAuthIdentities>;
    mfaEnabled: boolean;
  };
  preferences: ReturnType<typeof getUserPrefs>;
  sessions: Array<Omit<ReturnType<typeof listSessionsForUser>[number], 'ip'>>;
  apiKeys: ReturnType<typeof listApiKeysForOwner>;
  passkeys: ReturnType<typeof listPasskeysForUser>;
  jobs: ReturnType<typeof getUserJobHistory>;
  activity?: ReturnType<typeof getUserActivityStats> extends Map<string, infer Value> ? Value : never;
  testFlightSubscriptions: ReturnType<typeof listTestFlightSubscriptionsForUser>;
  billing: {
    subscriptions: ReturnType<typeof getBillingSubscriptionsForUser>;
    entitlementHistory: ReturnType<typeof listBillingEntitlementHistory>;
  };
}

export function buildAccountExport(userId: string): AccountExport {
  const profile = getAuthProfile(userId);
  const activity = getUserActivityStats().get(userId.toLowerCase());
  return {
    exportedAt: new Date().toISOString(),
    account: {
      userId,
      displayName: profile?.displayName,
      email: profile?.email,
      identities: getLinkedAuthIdentities(userId),
      mfaEnabled: mfaStatus(userId).enabled,
    },
    preferences: getUserPrefs(userId),
    sessions: listSessionsForUser(userId).map(({ ip: _ip, ...session }) => session),
    apiKeys: listApiKeysForOwner(userId),
    passkeys: listPasskeysForUser(userId),
    jobs: getUserJobHistory(userId),
    activity,
    testFlightSubscriptions: listTestFlightSubscriptionsForUser(userId),
    billing: {
      subscriptions: getBillingSubscriptionsForUser(userId),
      entitlementHistory: listBillingEntitlementHistory().filter((event) => event.userId === userId),
    },
  };
}

export function accountDeletionBlocker(userId: string): string | undefined {
  if (userId === 'root') return 'the root account cannot be deleted';
  if (hasActiveBillingSubscription(userId)) return 'cancel the active billing subscription before deleting the account';
  const subscriptions = listTestFlightSubscriptionsForUser(userId).filter(
    (subscription) => subscription.status !== 'withdrawn' && subscription.bundleId !== 'com.hammerandchisel.discord',
  );
  if (subscriptions.length > 0) return 'withdraw or unsubscribe from TestFlight access before deleting the account';
  return undefined;
}

export function deleteAccount(userId: string): { ok: boolean; error?: string } {
  const error = accountDeletionBlocker(userId);
  if (error) return { ok: false, error };
  anonymizeBillingUser(userId);
  if (!deleteUserPersonalData(userId)) return { ok: false, error: 'account not found' };
  deleteAuthProfile(userId);
  recordAudit('system', 'privacy.delete', 'deleted-user', 'account data deleted and billing records anonymized');
  return { ok: true };
}
