const { Router } = require('express');
const paymentWebhookController = require('../controllers/paymentWebhookController');

const router = Router();

// No auth — these are called by Orange's servers / the payer's browser, not
// an Mboa Trust user. Orange's webpayment sandbox posts to notif_url as a
// server-to-server call and redirects the payer's browser to return_url/cancel_url.
router.get('/orange-money/notify', paymentWebhookController.notify);
router.post('/orange-money/notify', paymentWebhookController.notify);
router.get('/orange-money/return', paymentWebhookController.returnPage);
router.get('/orange-money/cancel', paymentWebhookController.cancelPage);

module.exports = router;
