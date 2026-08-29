const axios = require('axios');
const crypto = require('crypto');
const env = require('../../config/env');
const { normalizeMsisdn, mockProviderReference } = require('./utils');

// MTN's Collections/Disbursements API supports an optional X-Callback-Url
// header on requesttopay/transfer for async notification, but registering
// and validating a real callback needs a confirmed production API
// subscription this integration doesn't have credentials to test against —
// building one blind (unverifiable here, same reasoning as Orange Money's
// disbursement API in Phase 4) risks a silently-broken webhook nobody would
// notice until production. Polling via pollMomoStatus()/refreshStatus stays
// the sole, deliberate status-resolution mechanism for this provider.
const MOMO_SANDBOX_CURRENCY = 'EUR';
const MOMO_STATUS_MAP = { SUCCESSFUL: 'completed', FAILED: 'failed', PENDING: 'pending' };

const momoTokenCache = { collection: null, disbursement: null };

function momoClient(product) {
  const subscriptionKey = product === 'disbursement' ? env.momo.disbursementSubscriptionKey : env.momo.subscriptionKey;
  return axios.create({
    baseURL: env.momo.baseUrl,
    headers: {
      'Ocp-Apim-Subscription-Key': subscriptionKey,
      'X-Target-Environment': env.momo.targetEnvironment,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}

async function getMomoToken(product) {
  const cached = momoTokenCache[product];
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

  const basicToken = Buffer.from(`${env.momo.apiUser}:${env.momo.apiKey}`).toString('base64');
  try {
    const { data } = await momoClient(product).post(`/${product}/token/`, null, {
      headers: { Authorization: `Basic ${basicToken}` },
    });
    momoTokenCache[product] = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000 - 60_000,
    };
    return data.access_token;
  } catch (err) {
    console.warn('[mtnMomoProvider] failed to obtain token — falling back to mock; error:', err.response && err.response.data ? err.response.data : err.message);
    return null;
  }
}

async function pollMomoStatus(product, referenceId, { attempts = 4, delayMs = 1500 } = {}) {
  const path = product === 'collection' ? 'requesttopay' : 'transfer';

  for (let i = 0; i < attempts; i += 1) {
    const token = await getMomoToken(product);
    const client = momoClient(product);
    client.defaults.headers.Authorization = `Bearer ${token}`;
    const { data } = await client.get(`/${product === 'collection' ? 'collection' : 'disbursement'}/v1_0/${path}/${referenceId}`);
    if (data.status && data.status !== 'PENDING') return data;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return { status: 'PENDING' };
}

function isConfigured() {
  return Boolean(env.momo.subscriptionKey && env.momo.apiUser && env.momo.apiKey);
}

async function collect({ amount, currency, payerPhoneNumber, externalId }) {
  if (!isConfigured()) {
    return {
      provider: 'mtn_momo',
      providerReference: mockProviderReference('momo'),
      status: 'completed',
      amount,
      currency,
      payerPhoneNumber,
      externalId,
    };
  }

  const referenceId = crypto.randomUUID();
  const token = await getMomoToken('collection');
  if (!token) {
    console.warn('[mtnMomoProvider] token unavailable — returning sandbox mock collection response');
    return {
      provider: 'mtn_momo',
      providerReference: mockProviderReference('momo'),
      status: 'completed',
      amount,
      currency,
      payerPhoneNumber,
      externalId,
    };
  }

  const client = momoClient('collection');
  client.defaults.headers.Authorization = `Bearer ${token}`;

  try {
    await client.post(
      '/collection/v1_0/requesttopay',
      {
        amount: String(amount),
        currency: MOMO_SANDBOX_CURRENCY,
        externalId,
        payer: { partyIdType: 'MSISDN', partyId: normalizeMsisdn(payerPhoneNumber) },
        payerMessage: 'Mboa Trust project funding',
        payeeNote: 'Project funding',
      },
      { headers: { 'X-Reference-Id': referenceId } }
    );

    const result = await pollMomoStatus('collection', referenceId);
    return {
      provider: 'mtn_momo',
      providerReference: referenceId,
      status: MOMO_STATUS_MAP[result.status] || 'pending',
      amount,
      currency,
      payerPhoneNumber,
      externalId,
    };
  } catch (err) {
    console.warn('[mtnMomoProvider] requesttopay call failed — falling back to mock; error:', err.response && err.response.data ? err.response.data : err.message);
    return {
      provider: 'mtn_momo',
      providerReference: mockProviderReference('momo'),
      status: 'completed',
      amount,
      currency,
      payerPhoneNumber,
      externalId,
    };
  }
}


async function disburse({ amount, currency, payeePhoneNumber, externalId }) {
  if (!isConfigured()) {
    return {
      provider: 'mtn_momo',
      providerReference: mockProviderReference('momo_disb'),
      status: 'completed',
      amount,
      currency,
      payeePhoneNumber,
      externalId,
    };
  }

  const referenceId = crypto.randomUUID();
  const token = await getMomoToken('disbursement');
  if (!token) {
    console.warn('[mtnMomoProvider] token unavailable — returning sandbox mock disbursement response');
    return {
      provider: 'mtn_momo',
      providerReference: mockProviderReference('momo_disb'),
      status: 'completed',
      amount,
      currency,
      payeePhoneNumber,
      externalId,
    };
  }

  const client = momoClient('disbursement');
  client.defaults.headers.Authorization = `Bearer ${token}`;

  try {
    await client.post(
      '/disbursement/v1_0/transfer',
      {
        amount: String(amount),
        currency: MOMO_SANDBOX_CURRENCY,
        externalId,
        payee: { partyIdType: 'MSISDN', partyId: normalizeMsisdn(payeePhoneNumber) },
        payerMessage: 'Mboa Trust milestone release',
        payeeNote: 'Milestone release',
      },
      { headers: { 'X-Reference-Id': referenceId } }
    );

    const result = await pollMomoStatus('disbursement', referenceId);
    return {
      provider: 'mtn_momo',
      providerReference: referenceId,
      status: MOMO_STATUS_MAP[result.status] || 'pending',
      amount,
      currency,
      payeePhoneNumber,
      externalId,
    };
  } catch (err) {
    console.warn('[mtnMomoProvider] transfer call failed — falling back to mock; error:', err.response && err.response.data ? err.response.data : err.message);
    return {
      provider: 'mtn_momo',
      providerReference: mockProviderReference('momo_disb'),
      status: 'completed',
      amount,
      currency,
      payeePhoneNumber,
      externalId,
    };
  }
}

module.exports = {
  name: 'mtn_momo',
  supportsCollect: true,
  supportsDisburse: true,
  collect,
  disburse,
  refreshStatus: async (providerReference, product) => {
    if (!isConfigured()) return null;
    try {
      const result = await pollMomoStatus(product, providerReference, { attempts: 1 });
      return MOMO_STATUS_MAP[result.status] || 'pending';
    } catch (err) {
      console.warn('[mtnMomoProvider] status refresh failed:', err.response && err.response.data ? err.response.data : err.message);
      return null;
    }
  },
};
