import { EMBED_COLOR, notify } from '#notify.js';
import { claimExpiringApiKeysToNotify } from '#store/state.js';

const POLL_INTERVAL_MS = 60 * 60_000;

async function checkOnce(): Promise<void> {
  for (const key of claimExpiringApiKeysToNotify()) {
    const expiresAt = new Date(key.expiresAt).toISOString();
    await notify('keyExpiringSoon', {
      title: 'API key expiring soon',
      description: `**${key.name}** (owned by **${key.ownerId}**) expires **${expiresAt}** - regenerate or extend it before it stops working.`,
      color: EMBED_COLOR.warn,
    });
  }
}

export function startKeyExpiryPoller(): void {
  setInterval(() => void checkOnce(), POLL_INTERVAL_MS).unref();
}
