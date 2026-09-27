import type { Database } from 'bun:sqlite';
import type { TestFlightSubscription } from '#store/state.js';

export interface TestFlightSubscriptionRepository {
  listAll(): TestFlightSubscription[];
  listByUser(userId: string): TestFlightSubscription[];
  findById(id: string): TestFlightSubscription | undefined;
  findByInviteCode(inviteCode: string): TestFlightSubscription | undefined;
}

const joinedSubscriptionQuery = `
  SELECT subscriptions.payload AS subscription_payload, devices.payload AS device_payload
  FROM testflight_subscriptions AS subscriptions
  LEFT JOIN testflight_subscription_devices AS devices ON devices.subscription_id = subscriptions.id
`;

function subscriptionsFromRows(rows: Array<{ subscription_payload: string; device_payload: string | null }>): TestFlightSubscription[] {
  const subscriptions = new Map<string, TestFlightSubscription>();
  for (const row of rows) {
    const payload = JSON.parse(row.subscription_payload) as TestFlightSubscription;
    let subscription = subscriptions.get(payload.id);
    if (!subscription) {
      subscription = { ...payload, devices: [] };
      subscriptions.set(payload.id, subscription);
    }
    if (row.device_payload !== null) subscription.devices.push(JSON.parse(row.device_payload) as TestFlightSubscription['devices'][number]);
  }
  return [...subscriptions.values()];
}

export function createTestFlightSubscriptionRepository(database: Database): TestFlightSubscriptionRepository {
  const all = database.query(`${joinedSubscriptionQuery} ORDER BY subscriptions.created_at DESC, subscriptions.id DESC, devices.device_id ASC;`);
  const byUser = database.query(`${joinedSubscriptionQuery} WHERE subscriptions.requester_id = ? ORDER BY subscriptions.created_at DESC, subscriptions.id DESC, devices.device_id ASC;`);
  const byId = database.query(`${joinedSubscriptionQuery} WHERE subscriptions.id = ? ORDER BY devices.device_id ASC;`);
  const byInviteCode = database.query(`${joinedSubscriptionQuery} WHERE subscriptions.invite_code = ? AND subscriptions.subscription_status <> 'withdrawn' ORDER BY subscriptions.created_at DESC, subscriptions.id DESC, devices.device_id ASC;`);

  return {
    listAll() {
      return subscriptionsFromRows(all.all() as Array<{ subscription_payload: string; device_payload: string | null }>);
    },
    listByUser(userId) {
      return subscriptionsFromRows(byUser.all(userId.toLowerCase()) as Array<{ subscription_payload: string; device_payload: string | null }>);
    },
    findById(id) {
      const rows = byId.all(id) as Array<{ subscription_payload: string; device_payload: string | null }>;
      return subscriptionsFromRows(rows)[0];
    },
    findByInviteCode(inviteCode) {
      const rows = byInviteCode.all(inviteCode) as Array<{ subscription_payload: string; device_payload: string | null }>;
      return subscriptionsFromRows(rows)[0];
    },
  };
}
