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

module.exports = {
  name: 'orange_money',
  supportsCollect: true,
  supportsDisburse: true,
  collect,
  disburse,
};
