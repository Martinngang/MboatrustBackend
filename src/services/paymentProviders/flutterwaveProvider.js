const axios = require('axios');
const env = require('../../config/env');
const { mockProviderReference } = require('./utils');

/**
 * Initiate a Flutterwave payment (creates a hosted payment link) and return
 * a paymentUrl the client can redirect to. For demo, falls back to mock when
 * FLW keys are not set.
 */
async function collect({ amount, currency, externalId, projectId }) {
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
    redirect_url: `${env.appBaseUrl}/api/v1/payments/flutterwave/webhook`,
    customer: { email: 'payer@example.com' },
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

module.exports = {
  name: 'flutterwave',
  supportsCollect: true,
  supportsDisburse: false,
  collect,
  disburse,
};
