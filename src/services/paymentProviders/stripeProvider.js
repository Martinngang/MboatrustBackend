const Stripe = require('stripe');
const env = require('../../config/env');

/**
 * If STRIPE_SECRET_KEY is not set we fall back to a mock response so local
 * development doesn't require live keys. This keeps the same return shape
 * the paymentService and controllers expect (provider, providerReference, status, ...)
 */
const stripeConfigured = Boolean(env.stripe && env.stripe.secretKey);
const stripe = stripeConfigured ? new Stripe(env.stripe.secretKey, { apiVersion: '2022-11-15' }) : null;

async function collect({ amount, currency, externalId, projectId }) {
  if (!stripeConfigured) {
    // Lightweight mock response for local dev
    return {
      provider: 'stripe',
      providerReference: `stripe_mock_${Date.now()}`,
      status: 'completed',
      amount,
      currency,
    };
  }

  // Stripe expects amount in smallest currency unit (cents)
  const amountMinor = Math.round(amount * 100);
  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountMinor,
    currency: currency.toLowerCase(),
    metadata: { externalId: externalId || '', projectId: projectId || '' },
    automatic_payment_methods: { enabled: true },
  });

  return {
    provider: 'stripe',
    providerReference: paymentIntent.id,
    status: paymentIntent.status === 'succeeded' ? 'completed' : 'pending',
    amount,
    currency,
    clientSecret: paymentIntent.client_secret,
  };
}

async function disburse() {
  throw new Error('Stripe disbursement is not supported by this provider');
}

module.exports = {
  name: 'stripe',
  supportsCollect: true,
  supportsDisburse: false,
  collect,
  disburse,
};
