const axios = require('axios');
const crypto = require('crypto');
const env = require('../config/env');

const TEST_BASE_URL = 'https://testapi.smileidentity.com/v1';
const PRODUCTION_BASE_URL = 'https://api.smileidentity.com/v1';
const JOB_TYPE_BASIC_KYC = 5;

/** HMAC-SHA256(apiKey, timestamp + partnerId + "sid_request"), base64-encoded
 * — Smile Identity's documented request-signing scheme (matches their
 * official SDKs' `Signature.generate_signature`). */
function generateSignature(partnerId, apiKey, timestamp) {
  return crypto.createHmac('sha256', apiKey).update(timestamp, 'utf8').update(partnerId, 'utf8').update('sid_request', 'utf8').digest('base64');
}

// "Sandbox" vs "production" picks which of Smile ID's own base URLs to call
// — it is NOT the same thing as "credentials are configured". A real
// sandbox call is still a real call; only missing credentials should fall
// back to a mock. (This used to be inverted — sandbox=true short-circuited
// to a mock unconditionally, so real sandbox credentials were never used.)
function isConfigured() {
  return Boolean(env.smileIdentity.partnerId && env.smileIdentity.apiKey);
}

/**
 * Smile Identity Basic KYC (job_type 5): verifies an individual's ID number
 * against the issuing authority's records. Falls back to a mock "verified"
 * result with the exact shape a real call would return only when no
 * partner credentials are configured at all.
 */
async function verifyIdentity({ userId, idType, idNumber, country = 'CM', documentUrl }) {
  if (!isConfigured()) {
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

  const baseUrl = env.smileIdentity.sandbox ? TEST_BASE_URL : PRODUCTION_BASE_URL;
  const timestamp = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const { data } = await axios.post(
    `${baseUrl}/id_verification`,
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
    sandbox: env.smileIdentity.sandbox,
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
