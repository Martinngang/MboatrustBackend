const { Router } = require('express');
const { z } = require('zod');
const projectController = require('../controllers/projectController');
const matchingController = require('../controllers/matchingController');
const verifierInvitationController = require('../controllers/verifierInvitationController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const upload = require('../middleware/upload');
const idempotent = require('../middleware/idempotency');
const {
  createProject,
  updateProject,
  assignSupplier,
  fundProject,
  submitEvidence,
  decideApproval,
  requestChanges,
  updateLocation,
  requestLocationVerification,
} = require('../validators/projectValidators');
const { createDispute } = require('../validators/disputeValidators');
const { inviteVerifier } = require('../validators/verifierInvitationValidators');

const router = Router();

router.get('/', projectController.getAll);
router.get('/:id', projectController.getOne);
router.post('/', authenticate, validate(createProject), projectController.create);
router.patch('/:id', authenticate, validate(updateProject), projectController.update);
router.post('/:id/cancel', authenticate, projectController.cancel);
router.delete('/:id', authenticate, projectController.remove);

router.get('/:id/funding-summary', projectController.getFundingSummary);
router.get('/:id/funding-quote', projectController.getFundingQuote);
router.post(
  '/:id/co-signer',
  authenticate,
  validate(z.object({ coSignerId: z.string().min(1) })),
  projectController.addCoSigner
);
router.post(
  '/:id/assign-supplier',
  authenticate,
  validate(assignSupplier),
  projectController.assignSupplier
);
// PATCH, not POST — a pin correction, unlike assign-supplier/fund/etc.,
// has no side effect beyond the field itself (no notification, no money
// movement), so it doesn't need idempotency protection either.
router.patch(
  '/:id/location',
  authenticate,
  validate(updateLocation),
  projectController.updateLocation
);
router.patch(
  '/:id/milestones/:milestoneId/location',
  authenticate,
  validate(updateLocation),
  projectController.updateMilestoneLocation
);
router.get('/:projectId/recommended-contractors', authenticate, matchingController.getRecommended);
router.get('/:projectId/bids-with-scores', authenticate, matchingController.getBidsWithScores);
router.post('/:id/fund', authenticate, idempotent, validate(fundProject), projectController.fundProject);

// Project plan document — a follow-up multipart call after creation (see
// createProject's hasExistingPlan field), never part of POST /projects
// itself (which stays plain JSON, unchanged, shared by both frontends).
router.post('/:id/plan-document', authenticate, upload.single('file'), projectController.uploadPlanDocument);
router.get('/:id/plan-document', authenticate, projectController.getPlanDocument);

// Funder's "I don't know the exact location" path — a narrow, ownership-
// scoped alternative to the admin-only POST /verification-tasks.
router.get('/:id/recommended-verifiers', authenticate, projectController.getRecommendedVerifiersForProject);
router.post(
  '/:id/request-location-verification',
  authenticate,
  validate(requestLocationVerification),
  projectController.requestLocationVerification
);

// Alternative to the recommended-verifier flow above — the funder invites
// someone they already know by email/share link instead of picking from the
// approved list. See controllers/verifierInvitationController.js.
router.post(
  '/:id/verifier-invitations',
  authenticate,
  validate(inviteVerifier),
  verifierInvitationController.inviteVerifier
);
router.get(
  '/:id/verifier-invitations',
  authenticate,
  verifierInvitationController.listInvitationsForProject
);
router.post(
  '/:id/verifier-invitations/:invitationId/revoke',
  authenticate,
  verifierInvitationController.revokeInvitation
);

router.post(
  '/:id/milestones/:milestoneId/evidence',
  authenticate,
  upload.single('file'),
  validate(submitEvidence),
  projectController.submitEvidence
);
// "Proceed Without Full Escrow" — contractor-only, explicit acknowledgement
// required in the body; an override of the funded-milestone gate, never a
// funding or release action (see projectController.proceedAtRisk).
router.post('/:id/milestones/:milestoneId/proceed-at-risk', authenticate, projectController.proceedAtRisk);
// Approval can trigger an escrow release (real money), so it gets the same
// duplicate-submission guard as fund/refund.
router.post(
  '/:id/milestones/:milestoneId/approval',
  authenticate,
  idempotent,
  validate(decideApproval),
  projectController.decideApproval
);
router.post(
  '/:id/milestones/:milestoneId/request-changes',
  authenticate,
  validate(requestChanges),
  projectController.requestMilestoneChanges
);
router.post(
  '/:id/milestones/:milestoneId/dispute',
  authenticate,
  validate(createDispute.omit({ projectId: true, milestoneId: true })),
  projectController.disputeMilestone
);
router.post(
  '/:id/dispute',
  authenticate,
  validate(createDispute.omit({ projectId: true, milestoneId: true })),
  projectController.disputeMilestone
);

module.exports = router;
