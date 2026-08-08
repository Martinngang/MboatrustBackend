const crypto = require('crypto');

function mockProviderReference(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function normalizeMsisdn(phone) {
  return String(phone || '').replace(/[^\d]/g, '');
}

module.exports = { mockProviderReference, normalizeMsisdn };
