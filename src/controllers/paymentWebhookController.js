const crypto = require('crypto');
const Stripe = require('stripe');
const env = require('../config/env');
const { Escrow, Project } = require('../models');
const catchAsync = require('../utils/catchAsync');
const { logEvent } = require('../services/systemEventService');
const orangeMoneyProvider = require('../services/paymentProviders/orangeMoneyProvider');

const stripe = env.stripe.secretKey ? new Stripe(env.stripe.secretKey) : null;

/**
 * Orange Money's Web Payment flow (existing)
 */
const notify = catchAsync(async (req, res) => {
  const payload = { ...req.query, ...req.body };
  const reference = payload.pay_token || payload.notif_token || payload.token;
  const claimedStatus = String(payload.status || '').toUpperCase();
  if (!reference) {
    logEvent({ type: 'webhook_error', source: 'paymentWebhookController.notify', detail: { reason: 'missing payment token', payload } }).catch(() => {});
    return res.status(400).json({ success: false, error: 'missing payment token' });
  }

  const escrow = await Escrow.findOne({ paymentProvider: 'orange_money', providerReference: reference });
  if (!escrow) {
    logEvent({ type: 'webhook_error', source: 'paymentWebhookController.notify', detail: { reason: 'unknown transaction', reference } }).catch(() => {});
    return res.status(404).json({ success: false, error: 'unknown transaction' });
  }

  if (escrow.status === 'pending') {
    // The WebPay notify payload carries no signature — trusting its
    // `status` field directly would let anyone who learns/guesses a
    // pay_token POST a fake SUCCESS. Re-verify with Orange directly first;
    // only fall back to the payload's own claim when unconfigured or the
    // real check fails (matches every other provider's mock-tolerant
    // degradation, so sandbox/local dev without real Orange credentials
    // keeps working exactly as before).
    const orderId = `fund_${escrow.projectId}`;
    const verified = await orangeMoneyProvider.verifyTransactionStatus({ orderId, amount: escrow.grossAmount, payToken: reference });
    if (verified === null) {
      logEvent({ type: 'webhook_warning', source: 'paymentWebhookController.notify', detail: { reason: 'could not independently verify status — trusting webhook payload as a fallback', reference, claimedStatus } }).catch(() => {});
    }
    const statusRaw = verified ?? claimedStatus;
    escrow.status = ['SUCCESS', 'SUCCESSFUL'].includes(statusRaw) ? 'completed' : statusRaw === 'FAILED' ? 'failed' : 'pending';
    escrow.statusHistory.push({ status: escrow.status, detail: verified !== null ? 'orange_money webhook callback (independently verified)' : 'orange_money webhook callback (unverified — trusted payload)' });
    await escrow.save();

    if (escrow.status === 'completed' && escrow.type === 'fund') {
      const project = await Project.findById(escrow.projectId);
      if (project && project.status === 'open') {
        project.status = 'funded';
        await project.save();
      }
      logEvent({ type: 'payment_processed', severity: 'info', source: 'paymentWebhookController.notify', detail: { escrowId: escrow._id, projectId: escrow.projectId, amount: escrow.netAmount, currency: escrow.currency, verified: verified !== null } }).catch(() => {});
    }
  }

  return res.status(200).json({ success: true });
});

/**
 * Stripe webhook handler — verifies signature and marks Escrow completed
 */
const stripeWebhook = catchAsync(async (req, res) => {
  if (!stripe) return res.status(501).json({ success: false, error: 'Stripe not configured' });
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const raw = req.rawBody ? req.rawBody.toString('utf8') : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    event = stripe.webhooks.constructEvent(raw, sig, env.stripe.webhookSecret);
  } catch (err) {
    logEvent({ type: 'webhook_error', source: 'paymentWebhookController.stripeWebhook', detail: { reason: 'signature verification failed', error: err.message } }).catch(() => {});
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    const status = event.type === 'payment_intent.succeeded' ? 'completed' : 'failed';
    const escrow = await Escrow.findOne({ paymentProvider: 'stripe', providerReference: pi.id });
    if (escrow && escrow.status === 'pending') {
      escrow.status = status;
      escrow.statusHistory.push({ status, detail: `stripe webhook: ${event.type}` });
      await escrow.save();
      if (status === 'completed' && escrow.type === 'fund') {
        const project = await Project.findById(escrow.projectId);
        if (project && project.status === 'open') {
          project.status = 'funded';
          await project.save();
        }
      }
      if (status === 'completed') {
        logEvent({ type: 'payment_processed', severity: 'info', source: 'paymentWebhookController.stripeWebhook', detail: { escrowId: escrow._id, projectId: escrow.projectId, amount: escrow.netAmount, currency: escrow.currency, eventType: event.type } }).catch(() => {});
      }
    }
  }

  res.json({ received: true });
});

/**
 * Flutterwave webhook handler — basic HMAC verification using FLW secret if provided
 */
const flutterwaveWebhook = catchAsync(async (req, res) => {
  // NOT req.body — the global express.json() in app.js already parses and
  // drains the request body for every /api/v1 route before this handler's
  // own express.raw() middleware ever runs, so req.body is a parsed object
  // here, not the raw bytes signature verification needs. req.rawBody is
  // the same buffer express.json()'s `verify` hook captures for the Stripe
  // webhook (see app.js) — reusing it here is what actually works.
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const signature = req.headers['verif-hash'] || req.headers['x-flw-signature'];

  if (env.flutterwave.secretKey) {
    // Previously "failed open" here — a missing signature header was
    // silently trusted rather than rejected whenever a real secret key WAS
    // configured, letting anyone POST a fake "successful" status straight
    // to this endpoint with no signature at all. Only skip verification
    // entirely when no secret key is configured (unconfigured/local/sandbox
    // dev, matching every other provider's mock-tolerant convention) —
    // once a real key exists, a missing or wrong signature is now always a
    // hard 401.
    if (!signature) {
      logEvent({ type: 'webhook_error', source: 'paymentWebhookController.flutterwaveWebhook', detail: { reason: 'missing signature header' } }).catch(() => {});
      return res.status(401).json({ success: false, error: 'Missing signature' });
    }
    const expected = crypto.createHmac('sha256', env.flutterwave.secretKey).update(raw).digest('hex');
    if (signature !== expected) {
      logEvent({ type: 'webhook_error', source: 'paymentWebhookController.flutterwaveWebhook', detail: { reason: 'invalid signature' } }).catch(() => {});
      return res.status(401).json({ success: false, error: 'Invalid signature' });
    }
  }

  const payload = JSON.parse(raw.toString('utf8'));
  const event = payload.event || payload.data || payload;
  // Flutterwave webhook payloads vary — try to extract tx_ref / id and status
  const txRef = payload.data?.tx_ref || payload.data?.id || payload.tx_ref || payload.id;
  const statusRaw = payload.data?.status || payload.status || '';
  if (!txRef) {
    logEvent({ type: 'webhook_error', source: 'paymentWebhookController.flutterwaveWebhook', detail: { reason: 'missing reference', payload } }).catch(() => {});
    return res.status(400).json({ success: false, error: 'missing reference' });
  }

  const escrow = await Escrow.findOne({ paymentProvider: 'flutterwave', providerReference: txRef });
  if (!escrow) {
    logEvent({ type: 'webhook_error', source: 'paymentWebhookController.flutterwaveWebhook', detail: { reason: 'unknown transaction', txRef } }).catch(() => {});
    return res.status(404).json({ success: false, error: 'unknown transaction' });
  }

  if (escrow.status === 'pending') {
    escrow.status = String(statusRaw).toLowerCase() === 'successful' ? 'completed' : String(statusRaw).toLowerCase() === 'failed' ? 'failed' : escrow.status;
    escrow.statusHistory.push({ status: escrow.status, detail: 'flutterwave webhook callback' });
    await escrow.save();

    if (escrow.status === 'completed' && escrow.type === 'fund') {
      const project = await Project.findById(escrow.projectId);
      if (project && project.status === 'open') {
        project.status = 'funded';
        await project.save();
      }
      logEvent({ type: 'payment_processed', severity: 'info', source: 'paymentWebhookController.flutterwaveWebhook', detail: { escrowId: escrow._id, projectId: escrow.projectId, amount: escrow.netAmount, currency: escrow.currency } }).catch(() => {});
    }
  }

  return res.status(200).json({ success: true });
});

/** Browser landing pages after the payer returns from Orange's payment page. */
const returnPage = (req, res) => res.status(200).json({ success: true, message: 'Payment completed — you may close this window.' });
const cancelPage = (req, res) => res.status(200).json({ success: true, message: 'Payment cancelled.' });

module.exports = { notify, returnPage, cancelPage, stripeWebhook, flutterwaveWebhook };
