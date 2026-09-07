const smtpSettingsService = require('../services/smtpSettingsService');
const { sendEmail } = require('../services/mailerService');
const { renderEmailHtml } = require('../utils/emailTemplates');
const { logAdminAction } = require('../services/adminActionLogService');
const { EmailLog } = require('../models');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');

/** Never returns the password itself — see
 * smtpSettingsService.getSettingsForDisplay's own doc comment. */
const getSettings = catchAsync(async (req, res) => {
  const settings = await smtpSettingsService.getSettingsForDisplay();
  return ok(res, settings);
});

const updateSettings = catchAsync(async (req, res) => {
  const settings = await smtpSettingsService.updateSettings(req.body, req.user._id);
  await logAdminAction({
    adminId: req.user._id,
    action: 'smtpSettings.update',
    targetType: 'SmtpSettings',
    targetId: req.user._id, // singleton document has no natural id worth exposing here
    detail: {
      host: req.body.host,
      port: req.body.port,
      secure: req.body.secure,
      username: req.body.username,
      fromEmail: req.body.fromEmail,
      enabled: req.body.enabled,
      passwordChanged: Boolean(req.body.password),
    },
  });
  return ok(res, settings);
});

/** Sends one real message using whatever combination of saved settings +
 * this request's field overrides smtpSettingsService.getConfigForTest
 * resolves — so an admin can test values they haven't saved yet, or a
 * config staged as disabled, before committing to it. Goes through the
 * normal mailerService.sendEmail path (passing the resolved config as an
 * explicit override, since sendEmail would otherwise re-resolve the
 * *saved* config and ignore unsaved overrides entirely) so a test send
 * shows up in the same delivery log as every other email, tagged with a
 * distinct `type` for easy filtering. */
const sendTestEmail = catchAsync(async (req, res) => {
  const { to, ...overrides } = req.body;
  const config = await smtpSettingsService.getConfigForTest(overrides);
  if (!config) {
    throw ApiError.badRequest('Host, username, and a password (saved or provided) are all required to send a test email.');
  }

  const sent = await sendEmail(
    {
      to,
      subject: 'Mboa Trust — SMTP test email',
      html: renderEmailHtml({
        heading: 'SMTP configuration works',
        body: `This test email confirms Mboa Trust can send mail through ${config.host}:${config.port} as ${config.user}.`,
      }),
    },
    { type: 'smtp_test', triggeredByAdminId: req.user._id, relatedAction: 'smtpSettings.test' },
    config
  );

  // sendEmail only returns a boolean (every other call site treats it as
  // fire-and-forget) — the specific failure reason it already logged is
  // read back from EmailLog rather than duplicating that try/catch here.
  let error = null;
  if (!sent) {
    const log = await EmailLog.findOne({ type: 'smtp_test', recipientEmail: to }).sort('-createdAt').lean();
    error = log?.error || 'Send failed for an unknown reason';
  }

  await logAdminAction({
    adminId: req.user._id,
    action: 'smtpSettings.test',
    targetType: 'SmtpSettings',
    targetId: req.user._id,
    detail: { to, host: config.host, success: sent },
  });

  return ok(res, { success: sent, error });
});

module.exports = { getSettings, updateSettings, sendTestEmail };
