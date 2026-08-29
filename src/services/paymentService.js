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

/** Reverses a collected payment. Providers with a real, purpose-built
 * refund API (stripe, flutterwave — refunding a card/transaction charge,
 * not a generic payout) use it via `supportsRefund`; providers with no
 * such API (mtn_momo, orange_money — a mobile money "refund" really is
 * just a disbursement back to the payer) fall back to `disburse`, exactly
 * matching escrowController.refund's behavior before this function existed. */
async function refund(provider, params) {
  const adapter = getPaymentProvider(provider);
  if (adapter.supportsRefund) return adapter.refund(params);
  return disburse(provider, params);
}

module.exports = { collect, disburse, refreshStatus, refund };
