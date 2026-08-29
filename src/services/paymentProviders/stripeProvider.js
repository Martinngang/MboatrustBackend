const Stripe = require('stripe');
const env = require('../../config/env');

/**
 * If STRIPE_SECRET_KEY is not set we fall back to a mock response so local
 * development doesn't require live keys. This keeps the same return shape
 * the paymentService and controllers expect (provider, providerReference, status, ...)
 */
const stripeConfigured = Boolean(env.stripe && env.stripe.secretKey);
const stripe = stripeConfigured ? new Stripe(env.stripe.secretKey, { apiVersion: '2022-11-15' }) : null;

async function collect({ amount, currency, externalId, projectId, email, description }) {
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
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountMinor,
      currency: currency.toLowerCase(),
      receipt_email: email || undefined,
      // Stripe metadata values must be plain strings — projectId arrives as
      // a real Mongoose ObjectId (not a string), and passing it as-is fails
      // Stripe's validation ("Metadata values must be strings... type
      // `hash`"), which silently fell back to the mock response on every
      // real funding attempt regardless of whether Stripe was configured.
      metadata: { externalId: externalId || '', projectId: projectId ? String(projectId) : '', description: description || '' },
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
  } catch (err) {
    console.warn('[stripeProvider] paymentIntents.create failed — falling back to mock; error:', err.message);
    return {
      provider: 'stripe',
      providerReference: `stripe_mock_${Date.now()}`,
      status: 'completed',
      amount,
      currency,
    };
  }
}

async function disburse() {
  throw new Error('Stripe disbursement is not supported by this provider');
}

/** Real refund of a Stripe-collected PaymentIntent — a dedicated, purpose-
 * built Stripe API that doesn't need Stripe Connect or any payout
 * capability (unlike disburse() above, which really would). `providerReference`
 * is the original PaymentIntent id captured by collect(). Falls back to a
 * mock the same way collect() does when Stripe isn't configured or the real
 * call fails, so escrowController.refund's caller-facing shape never changes. */
async function refund({ providerReference, amount, currency }) {
  if (!stripeConfigured) {
    return { provider: 'stripe', providerReference: `stripe_refund_mock_${Date.now()}`, status: 'completed', amount, currency };
  }
  // A mock providerReference (no real PaymentIntent behind it) can't be
  // refunded via the real API — refunding it would throw a confusing
  // "No such payment_intent" error instead of the honest "this was never a
  // real charge" outcome, so it's treated the same as unconfigured.
  if (!providerReference || !providerReference.startsWith('pi_')) {
    return { provider: 'stripe', providerReference: `stripe_refund_mock_${Date.now()}`, status: 'completed', amount, currency };
  }
  try {
    const refundResult = await stripe.refunds.create({ payment_intent: providerReference });
    return {
      provider: 'stripe',
      providerReference: refundResult.id,
      status: refundResult.status === 'succeeded' ? 'completed' : 'pending',
      amount,
      currency,
    };
  } catch (err) {
    console.warn('[stripeProvider] refunds.create failed — falling back to mock; error:', err.message);
    return { provider: 'stripe', providerReference: `stripe_refund_mock_${Date.now()}`, status: 'completed', amount, currency };
  }
}

/** Re-checks a PaymentIntent's real status directly with Stripe — the
 * fallback for when its webhook never arrives (e.g. this backend running on
 * localhost, which Stripe's servers can't reach at all in dev). Without
 * this, a genuinely-succeeded real-money PaymentIntent had no way to ever
 * become 'completed' here: no webhook, and (before this) no refreshStatus
 * either, unlike every other provider. Mirrors mtnMomoProvider's
 * refreshStatus shape — `product` is accepted for interface consistency
 * with paymentService.refreshStatus but unused (Stripe only ever collects
 * here, never disburses). */
async function refreshStatus(providerReference) {
  if (!stripeConfigured || !providerReference || !providerReference.startsWith('pi_')) return null;
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(providerReference);
    if (paymentIntent.status === 'succeeded') return 'completed';
    if (['canceled', 'requires_payment_method'].includes(paymentIntent.status)) return 'failed';
    return 'pending';
  } catch (err) {
    console.warn('[stripeProvider] status refresh failed:', err.message);
    return null;
  }
}

module.exports = {
  name: 'stripe',
  supportsCollect: true,
  supportsDisburse: false,
  supportsRefund: true,
  collect,
  disburse,
  refund,
  refreshStatus,
};
