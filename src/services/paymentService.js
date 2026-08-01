const axios = require('axios');
const crypto = require('crypto');
const env = require('../config/env');

/**
 * Sandbox-backed payment service.
 *
 * When provider credentials are present in env, this makes real HTTP calls
 * against the MTN MoMo Developer sandbox (Collections + Disbursements) and
 * the Orange Money Web Payment sandbox, following each provider's published
 * protocol. When credentials are absent, every function falls back to the
 * original mock response shape so the funding/escrow flow keeps working
 * end-to-end during the demo without merchant accounts. Callers never
 * change — `collect`/`disburse` return the same shape either way.
 */

function isMomoConfigured() {
  return Boolean(env.momo.subscriptionKey && env.momo.apiUser && env.momo.apiKey);
}
function isOrangeConfigured() {
  return Boolean(env.orangeMoney.clientId && env.orangeMoney.clientSecret && env.orangeMoney.merchantKey);
}

function mockProviderReference(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function normalizeMsisdn(phone) {
  // MTN MoMo sandbox expects MSISDN digits only, no leading '+'.
  return String(phone || '').replace(/[^\d]/g, '');
}

// ---------------------------------------------------------------------------
// MTN MoMo — Collections (collect) + Disbursements (disburse)
// ---------------------------------------------------------------------------

const momoTokenCache = { collection: null, disbursement: null };

function momoClient() {
  return axios.create({
    baseURL: env.momo.baseUrl,
    headers: {
      'Ocp-Apim-Subscription-Key': env.momo.subscriptionKey,
      'X-Target-Environment': 'sandbox',
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}

/** product is 'collection' or 'disbursement' — each has its own OAuth token endpoint. */
async function getMomoToken(product) {
  const cached = momoTokenCache[product];
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

  const basicToken = Buffer.from(`${env.momo.apiUser}:${env.momo.apiKey}`).toString('base64');
  const { data } = await momoClient().post(`/${product}/token/`, null, {
    headers: { Authorization: `Basic ${basicToken}` },
  });
  momoTokenCache[product] = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 60_000, // refresh 1 min early
  };
  return data.access_token;
}

/** Polls a request-to-pay / transfer reference a few times so the demo can
 * return a resolved status instead of always leaving it PENDING — sandbox
 * transactions typically resolve within a couple seconds. */
async function pollMomoStatus(product, referenceId, { attempts = 4, delayMs = 1500 } = {}) {
  const path = product === 'collection' ? 'requesttopay' : 'transfer';
  for (let i = 0; i < attempts; i += 1) {
    const token = await getMomoToken(product);
    const client = momoClient();
    client.defaults.headers.Authorization = `Bearer ${token}`;
    const { data } = await client.get(`/${product === 'collection' ? 'collection' : 'disbursement'}/v1_0/${path}/${referenceId}`);
    if (data.status && data.status !== 'PENDING') return data;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { status: 'PENDING' };
}

const MOMO_STATUS_MAP = { SUCCESSFUL: 'completed', FAILED: 'failed', PENDING: 'pending' };

async function collectMtnMomo({ amount, currency, payerPhoneNumber, externalId }) {
  if (!isMomoConfigured()) {
    console.warn('[paymentService] MOMO_SUBSCRIPTION_KEY/API_USER/API_KEY not set — returning sandbox mock response');
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
  const client = momoClient();
  client.defaults.headers.Authorization = `Bearer ${token}`;
  await client.post(
    '/collection/v1_0/requesttopay',
    {
      amount: String(amount),
      currency,
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
}

async function disburseMtnMomo({ amount, currency, payeePhoneNumber, externalId }) {
  if (!isMomoConfigured()) {
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
  const client = momoClient();
  client.defaults.headers.Authorization = `Bearer ${token}`;
  await client.post(
    '/disbursement/v1_0/transfer',
    {
      amount: String(amount),
      currency,
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
}

// ---------------------------------------------------------------------------
// Orange Money — Web Payment sandbox (redirect flow: collections only)
// ---------------------------------------------------------------------------

let orangeTokenCache = null;

async function getOrangeToken() {
  if (orangeTokenCache && orangeTokenCache.expiresAt > Date.now()) return orangeTokenCache.accessToken;
  const basicToken = Buffer.from(`${env.orangeMoney.clientId}:${env.orangeMoney.clientSecret}`).toString('base64');
  const { data } = await axios.post(
    'https://api.orange.com/oauth/v3/token',
    new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    { headers: { Authorization: `Basic ${basicToken}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  orangeTokenCache = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 - 60_000 };
  return data.access_token;
}

/**
 * Orange Money Web Payment is a redirect flow, not a synchronous
 * request/response like MoMo: this call only *initiates* the payment and
 * returns a `payment_url` the payer must complete in their browser/USSD
 * app. The transaction resolves later via the `notif_url` webhook (see
 * `resolveOrangeMoneyWebhook` below), so the initial status is 'pending'
 * even in the success case — callers must not assume 'completed' here.
 */
async function collectOrangeMoney({ amount, currency, externalId }) {
  if (!isOrangeConfigured()) {
    console.warn('[paymentService] OM_CLIENT_ID/OM_CLIENT_SECRET/OM_MERCHANT_KEY not set — returning sandbox mock response');
    return {
      provider: 'orange_money',
      providerReference: mockProviderReference('om'),
      status: 'completed',
      amount,
      currency,
      externalId,
    };
  }

  const token = await getOrangeToken();
  const { data } = await axios.post(
    `${env.orangeMoney.baseUrl}/webpayment`,
    {
      merchant_key: env.orangeMoney.merchantKey,
      currency,
      order_id: externalId,
      amount,
      return_url: `${env.appBaseUrl}/api/v1/payments/orange-money/return`,
      cancel_url: `${env.appBaseUrl}/api/v1/payments/orange-money/cancel`,
      notif_url: `${env.appBaseUrl}/api/v1/payments/orange-money/notify`,
      lang: 'en',
      reference: externalId,
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );

  return {
    provider: 'orange_money',
    providerReference: data.pay_token || data.notif_token,
    status: 'pending',
    amount,
    currency,
    externalId,
    paymentUrl: data.payment_url,
  };
}

/**
 * No public Orange Money sandbox disbursement API is documented — this
 * codebase never routes a disbursement through Orange (milestone release
 * always uses MTN MoMo, see projectController.releaseMilestoneEscrow), so
 * this stays a mock matching the pre-integration shape rather than an
 * untestable guess at a private/partner-only endpoint.
 */
async function disburseOrangeMoney({ amount, currency, payeePhoneNumber, externalId }) {
  return {
    provider: 'orange_money',
    providerReference: mockProviderReference('om_disb'),
    status: 'completed',
    amount,
    currency,
    payeePhoneNumber,
    externalId,
  };
}

async function collect(provider, params) {
  return provider === 'orange_money' ? collectOrangeMoney(params) : collectMtnMomo(params);
}

async function disburse(provider, params) {
  return provider === 'orange_money' ? disburseOrangeMoney(params) : disburseMtnMomo(params);
}

/** Re-polls a still-pending MTN MoMo transaction (collection or disbursement). Orange
 * Money has no polling endpoint in this integration — it only resolves via webhook. */
async function refreshStatus(provider, providerReference, product) {
  if (provider !== 'mtn_momo' || !isMomoConfigured()) return null;
  const result = await pollMomoStatus(product, providerReference, { attempts: 1 });
  return MOMO_STATUS_MAP[result.status] || 'pending';
}

module.exports = { collect, disburse, refreshStatus, isMomoConfigured, isOrangeConfigured };
