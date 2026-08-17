const { Router } = require('express');
const paymentWebhookController = require('../controllers/paymentWebhookController');

const router = Router();

// No auth — these are called by payment providers' servers / the payer's browser
// Orange Money webpayment posts to notif_url as a server-to-server call and
// redirects the payer's browser to return_url/cancel_url.
router.get('/orange-money/notify', paymentWebhookController.notify);
router.post('/orange-money/notify', paymentWebhookController.notify);
router.get('/orange-money/return', paymentWebhookController.returnPage);
router.get('/orange-money/cancel', paymentWebhookController.cancelPage);

// Both signature-verified webhooks below read req.rawBody (captured by the
// global express.json() in app.js) rather than a route-level express.raw()
// — the global JSON parser already runs first for every /api/v1 route and
// drains the body stream, so a route-level raw parser here would never
// actually see the real bytes.
router.post('/stripe/webhook', paymentWebhookController.stripeWebhook);
router.post('/flutterwave/webhook', paymentWebhookController.flutterwaveWebhook);

module.exports = router;
