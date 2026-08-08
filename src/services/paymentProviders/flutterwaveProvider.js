const { mockProviderReference } = require('./utils');

async function collect({ amount, currency, externalId }) {
  return {
    provider: 'flutterwave',
    providerReference: mockProviderReference('flutterwave'),
    status: 'completed',
    amount,
    currency,
    externalId,
  };
}

async function disburse() {
  throw new Error('Flutterwave disbursement is not supported in this stage');
}

module.exports = {
  name: 'flutterwave',
  supportsCollect: true,
  supportsDisburse: false,
  collect,
  disburse,
};
