import { EMBED_COLOR, notify } from '#notify.js';
import { scopedLogger } from '#logger.js';
import { trackBackgroundWork } from '#backgroundWork.js';
import { claimExpiringApiKeysToNotify } from '#store/state.js';

const log = scopedLogger('keys');
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
  keyExpiryTimer ??= setInterval(() => {
    void trackBackgroundWork('api-key-expiry-check', checkOnce)
      .catch((error: unknown) => log.warn('API key expiry poll failed', { error: String(error) }));
  }, POLL_INTERVAL_MS).unref();
}

let keyExpiryTimer: NodeJS.Timeout | undefined;

export function stopKeyExpiryPoller(): void {
  if (keyExpiryTimer) clearInterval(keyExpiryTimer);
  keyExpiryTimer = undefined;
}
