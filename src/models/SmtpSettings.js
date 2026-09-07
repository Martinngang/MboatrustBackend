const { Schema, model } = require('mongoose');

/** Platform-wide, single-document SMTP configuration editable from the
 * Admin dashboard — see services/smtpSettingsService.js. The `singleton`
 * field's unique index is what actually enforces "exactly one document":
 * every read/write goes through findOne/findOneAndUpdate keyed on it,
 * so a second document can never be created by accident.
 *
 * `passwordEncrypted` is the ONLY place the SMTP password is ever stored —
 * always AES-256-GCM ciphertext (see utils/crypto.js), never the plaintext
 * password. It is never selected back out to an API response; the admin
 * dashboard only ever learns whether a password is set, never what it is
 * (see smtpSettingsService.getSettingsForDisplay). */
const SmtpSettingsSchema = new Schema(
  {
    singleton: { type: String, default: 'singleton', unique: true },
    host: { type: String, default: '', trim: true },
    port: { type: Number, default: 587 },
    // TLS/SSL toggle — true for implicit TLS (typically port 465), false
    // for STARTTLS/plain (typically 587), matching nodemailer's own
    // `secure` option semantics exactly so this maps straight through.
    secure: { type: Boolean, default: false },
    username: { type: String, default: '', trim: true },
    passwordEncrypted: { type: String, default: '', select: false },
    fromEmail: { type: String, default: '', trim: true, lowercase: true },
    fromName: { type: String, default: '', trim: true },
    // Global kill switch — independent of whether host/username/password
    // are actually filled in, so an admin can stage a config without it
    // going live, or instantly stop all outbound email without clearing
    // credentials they'll want back.
    enabled: { type: Boolean, default: false },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = model('SmtpSettings', SmtpSettingsSchema);
