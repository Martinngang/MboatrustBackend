const { Router } = require('express');

const router = Router();

router.use('/users', require('./userRoutes'));
router.use('/admin/users', require('./adminUserRoutes'));
router.use('/admin/platform-stats', require('./platformStatsRoutes'));
router.use('/tools', require('./toolsRoutes'));
router.use('/projects', require('./projectRoutes'));
router.use('/escrows', require('./escrowRoutes'));
router.use('/bids', require('./bidRoutes'));
router.use('/contractor-profiles', require('./contractorProfileRoutes'));
router.use('/pooled-contributions', require('./pooledFundingRoutes'));
router.use('/contractor-certifications', require('./contractorCertificationRoutes'));
router.use('/land-offers', require('./landOfferRoutes'));
router.use('/visit-requests', require('./visitRequestRoutes'));
router.use('/notification-preferences', require('./notificationPreferenceRoutes'));
router.use('/groups', require('./groupRoutes'));
router.use('/contracts', require('./contractRoutes'));
router.use('/land-listings', require('./landListingRoutes'));
router.use('/verification-tasks', require('./verificationRoutes'));
router.use('/video-verifications', require('./videoVerificationRoutes'));
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
router.use('/team-members', require('./teamMemberRoutes'));
router.use('/project-templates', require('./projectTemplateRoutes'));

module.exports = router;
