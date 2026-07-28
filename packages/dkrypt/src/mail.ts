import nodemailer, { type Transporter } from 'nodemailer';
import { config, emailEnabled } from '#config.js';
import { getAuthProfile, listAuthProfiles } from '#identity.js';
import { scopedLogger } from '#logger.js';
import { getUserPrefs } from '#store/state.js';

const log = scopedLogger('mail');

let transporter: Transporter | undefined;

function getTransporter(): Transporter | undefined {
  if (!emailEnabled) return undefined;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: { user: config.smtpUser, pass: config.smtpPass },
    });
  }
  return transporter;
}

export interface MailPayload {
  subject: string;
  text: string;
}

export function resolveNotifyEmail(userId: string): string | undefined {
  const custom = getUserPrefs(userId).notifyEmail?.trim();
  return custom || getAuthProfile(userId)?.email;
}

export async function sendMailToUser(userId: string, payload: MailPayload): Promise<void> {
  const t = getTransporter();
  if (!t) return;

  const email = resolveNotifyEmail(userId);
  if (!email) return;

  try {
    await t.sendMail({ from: config.smtpFrom, to: email, subject: payload.subject, text: payload.text });
  } catch (err) {
    log.warn('mail send failed', { userId, error: String(err) });
  }
}

export type MailCategory = 'deviceAlert' | 'keyExpiry';

const CATEGORY_PREF_KEY: Record<MailCategory, 'emailOnAlerts' | 'emailOnKeyExpiry'> = {
  deviceAlert: 'emailOnAlerts',
  keyExpiry: 'emailOnKeyExpiry',
};

export async function sendMailToAllSubscribed(payload: MailPayload, category: MailCategory): Promise<void> {
  if (!emailEnabled) return;
  const prefKey = CATEGORY_PREF_KEY[category];
  const recipients = listAuthProfiles().filter((profile) => resolveNotifyEmail(profile.userId) && (getUserPrefs(profile.userId)[prefKey] ?? false));
  await Promise.all(recipients.map((profile) => sendMailToUser(profile.userId, payload)));
}
