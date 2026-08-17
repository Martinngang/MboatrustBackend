const crypto = require('crypto');
const Stripe = require('stripe');
const env = require('../config/env');
const { Escrow, Project } = require('../models');
const catchAsync = require('../utils/catchAsync');

const stripe = env.stripe.secretKey ? new Stripe(env.stripe.secretKey) : null;

/**
 * Orange Money's Web Payment flow (existing)
 */
const notify = catchAsync(async (req, res) => {
  const payload = { ...req.query, ...req.body };
  const reference = payload.pay_token || payload.notif_token || payload.token;
  const statusRaw = String(payload.status || '').toUpperCase();
  if (!reference) return res.status(400).json({ success: false, error: 'missing payment token' });

  const escrow = await Escrow.findOne({ paymentProvider: 'orange_money', providerReference: reference });
  if (!escrow) return res.status(404).json({ success: false, error: 'unknown transaction' });

  if (escrow.status === 'pending') {
    escrow.status = ['SUCCESS', 'SUCCESSFUL'].includes(statusRaw) ? 'completed' : statusRaw === 'FAILED' ? 'failed' : 'pending';
    await escrow.save();

    if (escrow.status === 'completed' && escrow.type === 'fund') {
      const project = await Project.findById(escrow.projectId);
      if (project && project.status === 'open') {
        project.status = 'funded';
        await project.save();
      }
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
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    const status = event.type === 'payment_intent.succeeded' ? 'completed' : 'failed';
    const escrow = await Escrow.findOne({ paymentProvider: 'stripe', providerReference: pi.id });
    if (escrow && escrow.status === 'pending') {
      escrow.status = status;
      await escrow.save();
      if (status === 'completed' && escrow.type === 'fund') {
        const project = await Project.findById(escrow.projectId);
        if (project && project.status === 'open') {
          project.status = 'funded';
          await project.save();
        }
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

  if (env.flutterwave.secretKey && signature) {
    const expected = crypto.createHmac('sha256', env.flutterwave.secretKey).update(raw).digest('hex');
    if (signature !== expected) return res.status(400).json({ success: false, error: 'Invalid signature' });
  }

  const payload = JSON.parse(raw.toString('utf8'));
  const event = payload.event || payload.data || payload;
  // Flutterwave webhook payloads vary — try to extract tx_ref / id and status
  const txRef = payload.data?.tx_ref || payload.data?.id || payload.tx_ref || payload.id;
  const statusRaw = payload.data?.status || payload.status || '';
  if (!txRef) return res.status(400).json({ success: false, error: 'missing reference' });

  const escrow = await Escrow.findOne({ paymentProvider: 'flutterwave', providerReference: txRef });
  if (!escrow) return res.status(404).json({ success: false, error: 'unknown transaction' });

  if (escrow.status === 'pending') {
    escrow.status = String(statusRaw).toLowerCase() === 'successful' ? 'completed' : String(statusRaw).toLowerCase() === 'failed' ? 'failed' : escrow.status;
    await escrow.save();

    if (escrow.status === 'completed' && escrow.type === 'fund') {
      const project = await Project.findById(escrow.projectId);
      if (project && project.status === 'open') {
        project.status = 'funded';
        await project.save();
      }
    }
  }

  return res.status(200).json({ success: true });
});

/** Browser landing pages after the payer returns from Orange's payment page. */
const returnPage = (req, res) => res.status(200).json({ success: true, message: 'Payment completed — you may close this window.' });
const cancelPage = (req, res) => res.status(200).json({ success: true, message: 'Payment cancelled.' });

module.exports = { notify, returnPage, cancelPage, stripeWebhook, flutterwaveWebhook };
