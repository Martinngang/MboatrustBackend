const { getPaymentProvider } = require('./paymentProviders');

async function collect(provider, params) {
  const adapter = getPaymentProvider(provider);
  if (!adapter.supportsCollect) {
    throw new Error(`Payment provider "${provider}" does not support collection`);
  }
  return adapter.collect(params);
}

async function disburse(provider, params) {
  const adapter = getPaymentProvider(provider);
  if (!adapter.supportsDisburse) {
    throw new Error(`Payment provider "${provider}" does not support disbursement`);
  }
  return adapter.disburse(params);
}

async function refreshStatus(provider, providerReference, product) {
  const adapter = getPaymentProvider(provider);
  if (typeof adapter.refreshStatus !== 'function') return null;
  return adapter.refreshStatus(providerReference, product);
}

module.exports = { collect, disburse, refreshStatus };
