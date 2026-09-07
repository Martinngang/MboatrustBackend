const crypto = require('crypto');
const { settingsEncryptionKey } = require('../config/env');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended nonce size for GCM

/** Any string works as the configured key — hashed to exactly 32 bytes via
 * SHA-256, so an admin/operator can set SETTINGS_ENCRYPTION_KEY to any real
 * passphrase without worrying about hex formatting or byte length. */
function getKey() {
  if (!settingsEncryptionKey) {
    throw new Error('SETTINGS_ENCRYPTION_KEY is not configured — cannot encrypt or decrypt stored secrets.');
  }
  return crypto.createHash('sha256').update(settingsEncryptionKey).digest();
}

/** AES-256-GCM: a fresh random IV per call (never reused with the same key,
 * which would break GCM's confidentiality guarantee), plus the auth tag, so
 * tampering with the stored ciphertext is detected on decrypt rather than
 * silently producing garbage. Output is a single delimited string, safe to
 * store directly in a Mongo string field. */
function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decrypt(payload) {
  const key = getKey();
  const [ivHex, authTagHex, dataHex] = String(payload).split(':');
  if (!ivHex || !authTagHex || !dataHex) throw new Error('Malformed encrypted payload');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
