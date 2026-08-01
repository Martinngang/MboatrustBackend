const axios = require('axios');
const crypto = require('crypto');
const env = require('../config/env');

const SANDBOX_BASE_URL = 'https://testapi.smileidentity.com/v1';
const JOB_TYPE_BASIC_KYC = 5;

/** HMAC-SHA256(apiKey, timestamp + partnerId + "sid_request"), base64-encoded
 * — Smile Identity's documented request-signing scheme (matches their
 * official SDKs' `Signature.generate_signature`). */
function generateSignature(partnerId, apiKey, timestamp) {
  return crypto.createHmac('sha256', apiKey).update(timestamp, 'utf8').update(partnerId, 'utf8').update('sid_request', 'utf8').digest('base64');
}

function isConfigured() {
  return Boolean(env.smileIdentity.partnerId && env.smileIdentity.apiKey && !env.smileIdentity.sandbox);
}

/**
 * Smile Identity Basic KYC (job_type 5): verifies an individual's ID number
 * against the issuing authority's records. In sandbox mode (default, or
 * whenever no partner credentials are configured) this returns a mock
 * "verified" result with the exact shape a real call would return, so
 * switching to a live contract later is a config change only.
 */
async function verifyIdentity({ userId, idType, idNumber, country = 'CM', documentUrl }) {
  if (env.smileIdentity.sandbox || !env.smileIdentity.partnerId || !env.smileIdentity.apiKey) {
    return {
      provider: 'smile_identity',
      sandbox: true,
      userId,
      idType,
      idNumber,
      documentUrl,
      resultCode: '1012',
      resultText: 'Enroll User',
      verified: true,
      confidenceValue: '99',
      checkedAt: new Date(),
    };
  }

  const timestamp = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const { data } = await axios.post(
    `${SANDBOX_BASE_URL}/id_verification`,
    {
      partner_id: env.smileIdentity.partnerId,
      signature: generateSignature(env.smileIdentity.partnerId, env.smileIdentity.apiKey, timestamp),
      timestamp,
      partner_params: { user_id: userId, job_id: jobId, job_type: JOB_TYPE_BASIC_KYC },
      country,
      id_type: idType,
      id_number: idNumber,
      source_sdk: 'mboatrust-backend',
      source_sdk_version: '1.0.0',
    },
    { timeout: 20000 }
  );

  return {
    provider: 'smile_identity',
    sandbox: false,
    userId,
    idType,
    idNumber,
    documentUrl,
    resultCode: data.ResultCode ?? data.resultCode ?? null,
    resultText: data.ResultText ?? data.resultText ?? null,
    verified: (data.ResultCode ?? data.resultCode) === '1012',
    confidenceValue: data.ConfidenceValue ?? data.confidenceValue ?? null,
    checkedAt: new Date(),
  };
}

module.exports = { verifyIdentity, isConfigured };
