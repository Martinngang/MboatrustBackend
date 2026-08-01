const { Router } = require('express');

const router = Router();

router.use('/users', require('./userRoutes'));
router.use('/projects', require('./projectRoutes'));
router.use('/escrows', require('./escrowRoutes'));
router.use('/bids', require('./bidRoutes'));
router.use('/contracts', require('./contractRoutes'));
router.use('/land-listings', require('./landListingRoutes'));
router.use('/verification-tasks', require('./verificationRoutes'));
router.use('/disputes', require('./disputeRoutes'));
router.use('/ratings', require('./ratingRoutes'));
router.use('/risk-flags', require('./riskFlagRoutes'));
router.use('/conversations', require('./conversationRoutes'));
router.use('/notifications', require('./notificationRoutes'));
router.use('/referrals', require('./referralRoutes'));
router.use('/fee-config', require('./feeConfigRoutes'));
router.use('/subscriptions', require('./subscriptionRoutes'));
router.use('/kyc', require('./kycRoutes'));
router.use('/payments', require('./paymentWebhookRoutes'));
router.use('/dev', require('./devRoutes'));

module.exports = router;
