const { Router } = require('express');
const paymentWebhookController = require('../controllers/paymentWebhookController');

const express = require('express');
const router = Router();

// No auth — these are called by payment providers' servers / the payer's browser
// Orange Money webpayment posts to notif_url as a server-to-server call and
// redirects the payer's browser to return_url/cancel_url.
router.get('/orange-money/notify', paymentWebhookController.notify);
router.post('/orange-money/notify', paymentWebhookController.notify);
router.get('/orange-money/return', paymentWebhookController.returnPage);
router.get('/orange-money/cancel', paymentWebhookController.cancelPage);

// Stripe webhook — use raw body for signature verification
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), paymentWebhookController.stripeWebhook);

// Flutterwave webhook — accept raw body so signature checks can use exact payload
router.post('/flutterwave/webhook', express.raw({ type: '*/*' }), paymentWebhookController.flutterwaveWebhook);

module.exports = router;
