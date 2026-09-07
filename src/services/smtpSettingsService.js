const { SmtpSettings } = require('../models');
const { encrypt, decrypt } = require('../utils/crypto');
const { smtp: envSmtp } = require('../config/env');

const SINGLETON_ID = 'singleton';

function buildFrom(fromName, fromEmail, fallback) {
  const address = fromEmail || fallback;
  return fromName ? `"${fromName}" <${address}>` : address;
}

/** What the Admin dashboard displays and edits — the encrypted password
 * itself never leaves this module. `hasPassword` is the only signal the UI
 * gets about it, so "leave blank to keep the current password" has
 * something real to check against. `source` tells the UI whether it's
 * showing real saved settings or just the untouched .env bootstrap defaults
 * (no document saved yet). */
async function getSettingsForDisplay() {
  // passwordEncrypted is `select: false` on the schema (defense in depth
  // against it leaking into some other unrelated query) — explicitly
  // re-selected here since this function needs to check *whether* one is
  // set. It's still never put on the returned object, only Boolean()'d.
  const doc = await SmtpSettings.findOne({ singleton: SINGLETON_ID }).select('+passwordEncrypted').lean();
  if (!doc) {
    return {
      host: envSmtp.host, port: envSmtp.port, secure: envSmtp.secure, username: envSmtp.user,
      fromEmail: envSmtp.from, fromName: '', enabled: Boolean(envSmtp.host && envSmtp.user && envSmtp.pass),
      hasPassword: Boolean(envSmtp.pass), source: 'env', updatedAt: null, updatedBy: null,
    };
  }
  return {
    host: doc.host, port: doc.port, secure: doc.secure, username: doc.username,
    fromEmail: doc.fromEmail, fromName: doc.fromName, enabled: doc.enabled,
    hasPassword: Boolean(doc.passwordEncrypted),
    source: 'database', updatedAt: doc.updatedAt, updatedBy: doc.updatedBy,
  };
}

/** The one function mailerService actually sends through. The database is
 * authoritative the moment any document exists — .env is purely the
 * pre-Admin-UI bootstrap default, used only when nobody has ever saved
 * settings here. Returns null whenever sending should be skipped:
 * `enabled` is off, or host/username/password aren't all present.
 * `ignoreEnabledFlag` is set only by the "send test email" path — testing a
 * config should work even while it's staged as disabled, so an admin can
 * verify credentials before flipping the switch. */
async function getActiveConfig({ ignoreEnabledFlag = false } = {}) {
  const doc = await SmtpSettings.findOne({ singleton: SINGLETON_ID }).select('+passwordEncrypted').lean();
  if (doc) {
    if (!ignoreEnabledFlag && !doc.enabled) return null;
    if (!doc.host || !doc.username || !doc.passwordEncrypted) return null;
    return {
      host: doc.host,
      port: doc.port,
      secure: doc.secure,
      user: doc.username,
      pass: decrypt(doc.passwordEncrypted),
      from: buildFrom(doc.fromName, doc.fromEmail, doc.username),
    };
  }
  if (!envSmtp.host || !envSmtp.user || !envSmtp.pass) return null;
  return { host: envSmtp.host, port: envSmtp.port, secure: envSmtp.secure, user: envSmtp.user, pass: envSmtp.pass, from: envSmtp.from };
}

/** Builds the config a "Send Test Email" call should use — form field
 * overrides take precedence field-by-field over whatever's already saved,
 * so an admin can test values they haven't saved yet (a new host/port) or
 * mix in an untouched password with a changed host. Falls back to
 * getActiveConfig (ignoring `enabled`) when no overrides are given at all,
 * i.e. "just test what's currently saved." Returns null when there isn't
 * enough information to attempt a send either way. */
async function getConfigForTest(overrides = {}) {
  const hasAnyOverride = ['host', 'port', 'secure', 'username', 'password', 'fromEmail', 'fromName'].some(
    (k) => overrides[k] !== undefined
  );
  if (!hasAnyOverride) return getActiveConfig({ ignoreEnabledFlag: true });

  const saved = await SmtpSettings.findOne({ singleton: SINGLETON_ID }).select('+passwordEncrypted').lean();
  const host = overrides.host ?? saved?.host ?? '';
  const port = overrides.port ?? saved?.port ?? 587;
  const secure = overrides.secure ?? saved?.secure ?? false;
  const username = overrides.username ?? saved?.username ?? '';
  const fromEmail = overrides.fromEmail ?? saved?.fromEmail ?? '';
  const fromName = overrides.fromName ?? saved?.fromName ?? '';
  // A blank/omitted password in the test request means "use whatever's
  // already saved" (mirroring the same convention updateSettings uses) —
  // never "send with an empty password."
  const pass = overrides.password || (saved?.passwordEncrypted ? decrypt(saved.passwordEncrypted) : '');

  if (!host || !username || !pass) return null;
  return { host, port, secure, user: username, pass, from: buildFrom(fromName, fromEmail, username) };
}

/** Upserts the single settings document. `password` is optional on every
 * call — omitting/blanking it leaves whatever's already encrypted and
 * stored untouched, the standard "don't make me re-type the secret every
 * time I tweak an unrelated field" pattern for credential forms. */
async function updateSettings(fields, adminId) {
  const update = {
    host: fields.host,
    port: fields.port,
    secure: fields.secure,
    username: fields.username,
    fromEmail: fields.fromEmail,
    fromName: fields.fromName,
    enabled: fields.enabled,
    updatedBy: adminId,
  };
  if (fields.password) {
    update.passwordEncrypted = encrypt(fields.password);
  }
  await SmtpSettings.findOneAndUpdate(
    { singleton: SINGLETON_ID },
    { $set: update, $setOnInsert: { singleton: SINGLETON_ID } },
    { new: true, upsert: true, runValidators: true }
  );
  return getSettingsForDisplay();
}

module.exports = { getSettingsForDisplay, getActiveConfig, getConfigForTest, updateSettings };
