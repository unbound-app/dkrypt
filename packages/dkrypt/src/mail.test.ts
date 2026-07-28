import { describe, expect, test } from 'bun:test';
import { sendMailToAllSubscribed, sendMailToUser } from '#mail.js';

describe('mail', () => {
  test('sendMailToUser is a no-op without SMTP configured', async () => {
    await expect(sendMailToUser('nobody', { subject: 'x', text: 'y' })).resolves.toBeUndefined();
  });

  test('sendMailToAllSubscribed is a no-op without SMTP configured', async () => {
    await expect(sendMailToAllSubscribed({ subject: 'x', text: 'y' }, 'deviceAlert')).resolves.toBeUndefined();
  });
});
