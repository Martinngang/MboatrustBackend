const axios = require('axios');
const env = require('../../config/env');
const { mockProviderReference } = require('./utils');

function isConfigured() {
  return Boolean(env.orangeMoney.clientId && env.orangeMoney.clientSecret && env.orangeMoney.merchantKey);
}

async function getOrangeToken() {
  const basicToken = Buffer.from(`${env.orangeMoney.clientId}:${env.orangeMoney.clientSecret}`).toString('base64');
  try {
    const { data } = await axios.post(
      'https://api.orange.com/oauth/v3/token',
      new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
      { headers: { Authorization: `Basic ${basicToken}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return data.access_token;
  } catch (err) {
    console.warn('[orangeMoneyProvider] failed to obtain token — falling back to mock; error:', err.response && err.response.data ? err.response.data : err.message);
    return null;
  }
}

async function collect({ amount, currency, externalId }) {
  if (!isConfigured()) {
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
  if (!token) {
    console.warn('[orangeMoneyProvider] token unavailable — returning sandbox mock collection response');
    return {
      provider: 'orange_money',
      providerReference: mockProviderReference('om'),
      status: 'completed',
      amount,
      currency,
      externalId,
    };
  }

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

async function disburse({ amount, currency, payeePhoneNumber, externalId }) {
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

/** Re-checks a WebPay collection's real status directly with Orange rather
 * than trusting the `status` field POSTed to the notify webhook — the
 * WebPay notify payload carries no signature, so anyone who learns/guesses
 * a `pay_token` could otherwise POST a fake "SUCCESS" and mark an escrow
 * completed for free. Reuses the same OAuth2 client-credentials token
 * collect() already gets. Returns null (never throws) when unconfigured or
 * the real call fails, so the caller can fall back to the payload's own
 * claim — same mock-tolerant convention as every other provider adapter —
 * rather than hard-failing local/sandbox environments with no real Orange
 * credentials. `orderId` must be the exact `order_id` collect() sent
 * Orange originally (see projectController.js's `fund_${projectId}`
 * convention for fund escrows) — Orange's status API matches on it. */
async function verifyTransactionStatus({ orderId, amount, payToken }) {
  if (!isConfigured() || !orderId || !payToken) return null;
  const token = await getOrangeToken();
  if (!token) return null;
  try {
    const { data } = await axios.post(
      `${env.orangeMoney.baseUrl}/transactionstatus`,
      { order_id: orderId, amount, pay_token: payToken },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    return String(data.status || '').toUpperCase() || null;
  } catch (err) {
    console.warn('[orangeMoneyProvider] transactionstatus check failed:', err.response && err.response.data ? err.response.data : err.message);
    return null;
  }
}

module.exports = {
  name: 'orange_money',
  supportsCollect: true,
  supportsDisburse: true,
  collect,
  disburse,
  verifyTransactionStatus,
};
