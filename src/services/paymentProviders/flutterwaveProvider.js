const axios = require('axios');
const env = require('../../config/env');
const { mockProviderReference } = require('./utils');

/**
 * Initiate a Flutterwave payment (creates a hosted payment link) and return
 * a paymentUrl the client can redirect to. For demo, falls back to mock when
 * FLW keys are not set.
 */
async function collect({ amount, currency, externalId, projectId, email, fullName, redirectUrl }) {
  if (!env.flutterwave.secretKey) {
    return {
      provider: 'flutterwave',
      providerReference: mockProviderReference('flutterwave'),
      status: 'completed',
      amount,
      currency,
      externalId,
    };
  }

  const payload = {
    tx_ref: externalId || `mboatrust_${Date.now()}`,
    amount: amount,
    currency,
    redirect_url: redirectUrl || `${env.appBaseUrl}/#/payment/callback`,
    customer: { email: email || 'payer@example.com', name: fullName || '' },
    meta: { projectId: projectId || '' },
  };

  try {
    const resp = await axios.post(`${env.flutterwave.baseUrl}/v3/payments`, payload, {
      headers: { Authorization: `Bearer ${env.flutterwave.secretKey}` },
      timeout: 15000,
    });

    const data = resp.data || {};
    if (data.status !== 'success') throw new Error('Flutterwave payment initiation failed');

    return {
      provider: 'flutterwave',
      providerReference: data.data.id || data.data.tx_ref || mockProviderReference('flutterwave'),
      status: 'pending',
      amount,
      currency,
      paymentUrl: data.data.link || data.data.authorization || null,
    };
  } catch (error) {
    return {
      provider: 'flutterwave',
      providerReference: mockProviderReference('flutterwave'),
      status: 'pending',
      amount,
      currency,
      paymentUrl: `${env.appBaseUrl}/api/v1/payments/flutterwave/webhook`,
      fallbackReason: error.message,
    };
  }
}

async function disburse() {
  throw new Error('Flutterwave disbursement is not supported by this provider in this stage');
}

/** Real refund via Flutterwave's dedicated refund endpoint — separate from
 * (and much smaller than) their Transfers/payout API, so this doesn't need
 * the same "not supported" treatment disburse() gets. `providerReference` is
 * the original transaction id captured by collect(). Falls back to a mock
 * the same way collect() does when unconfigured or the real call fails. */
async function refund({ providerReference, amount }) {
  if (!env.flutterwave.secretKey || !providerReference || providerReference.startsWith('flutterwave_')) {
    // No real credentials, or providerReference is one of collect()'s own
    // mock references (prefixed `flutterwave_...` via mockProviderReference) —
    // there's no real transaction behind it to refund.
    return { provider: 'flutterwave', providerReference: mockProviderReference('flutterwave_refund'), status: 'completed', amount };
  }
  try {
    const resp = await axios.post(
      `${env.flutterwave.baseUrl}/v3/transactions/${providerReference}/refund`,
      amount ? { amount } : {},
      { headers: { Authorization: `Bearer ${env.flutterwave.secretKey}` }, timeout: 15000 }
    );
    const data = resp.data || {};
    if (data.status !== 'success') throw new Error('Flutterwave refund initiation failed');
    return {
      provider: 'flutterwave',
      providerReference: String(data.data?.id ?? providerReference),
      status: data.data?.status === 'completed' ? 'completed' : 'pending',
      amount,
    };
  } catch (error) {
    return { provider: 'flutterwave', providerReference: mockProviderReference('flutterwave_refund'), status: 'completed', amount, fallbackReason: error.message };
  }
}

module.exports = {
  name: 'flutterwave',
  supportsCollect: true,
  supportsDisburse: false,
  supportsRefund: true,
  collect,
  disburse,
  refund,
};
