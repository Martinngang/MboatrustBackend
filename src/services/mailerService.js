const { buildTransporter } = require('../config/mailer');
const { getActiveConfig } = require('./smtpSettingsService');
const { EmailLog } = require('../models');

/** Writes the delivery record regardless of outcome — a logging failure
 * must never mask or throw over the real send result, same non-blocking
 * convention adminActionLogService.logAdminAction already uses. */
async function recordLog(fields) {
  try {
    await EmailLog.create(fields);
  } catch (err) {
    console.warn('[mailerService] failed to write EmailLog (non-blocking):', err.message);
  }
}

/**
 * Sends one transactional email and unconditionally records its outcome to
 * EmailLog — sent, failed, or skipped (SMTP disabled/unconfigured, or no
 * recipient address) — so delivery status is always inspectable via the
 * admin dashboard, not just inferred from whether notify() threw. A send
 * failure (bad creds, provider outage, invalid address) must never fail the
 * request that triggered it — same "log and move on" convention
 * notificationService.sendPush already uses for FCM.
 *
 * Resolves the active SMTP config (Admin-dashboard settings, falling back
 * to .env — see smtpSettingsService.getActiveConfig) fresh on every call,
 * so a settings change or the enabled toggle takes effect immediately.
 *
 * `meta` carries optional admin-attribution fields (recipientUserId,
 * triggeredByAdminId, relatedAction, relatedType, relatedId) purely for the
 * audit trail — never required for the send itself.
 *
 * `configOverride`, when passed, is used instead of resolving
 * getActiveConfig() — the one caller that needs this is the "send test
 * email" flow (adminSmtpSettingsController.sendTestEmail), which must be
 * able to test field values the admin hasn't saved yet, or a config staged
 * as disabled, neither of which getActiveConfig() would ever return.
 */
async function sendEmail({ to, subject, html, text }, meta = {}, configOverride = null) {
  const base = { recipientEmail: to || '', type: meta.type || 'unknown', subject, ...meta };

  if (!to) {
    await recordLog({ ...base, status: 'skipped', error: 'no_recipient_email' });
    return false;
  }

  const config = configOverride || (await getActiveConfig());
  if (!config) {
    await recordLog({ ...base, status: 'skipped', error: 'smtp_not_configured_or_disabled' });
    return false;
  }

  try {
    const transporter = buildTransporter(config);
    await transporter.sendMail({ from: config.from, to, subject, html, text });
    await recordLog({ ...base, status: 'sent' });
    return true;
  } catch (err) {
    console.warn(`[mailerService] failed to send email to ${to}:`, err.message);
    await recordLog({ ...base, status: 'failed', error: err.message });
    return false;
  }
}

module.exports = { sendEmail };
