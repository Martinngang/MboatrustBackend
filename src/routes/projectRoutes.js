const { Router } = require('express');
const { z } = require('zod');
const projectController = require('../controllers/projectController');
const matchingController = require('../controllers/matchingController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const upload = require('../middleware/upload');
const idempotent = require('../middleware/idempotency');
const {
  createProject,
  updateProject,
  assignQuincaillerie,
  fundProject,
  submitEvidence,
  decideApproval,
  requestChanges,
} = require('../validators/projectValidators');
const { createDispute } = require('../validators/disputeValidators');

const router = Router();

router.get('/', projectController.getAll);
router.get('/:id', projectController.getOne);
router.post('/', authenticate, validate(createProject), projectController.create);
router.patch('/:id', authenticate, validate(updateProject), projectController.update);
router.post('/:id/cancel', authenticate, projectController.cancel);
router.delete('/:id', authenticate, projectController.remove);

router.get('/:id/funding-summary', projectController.getFundingSummary);
router.post(
  '/:id/co-signer',
  authenticate,
  validate(z.object({ coSignerId: z.string().min(1) })),
  projectController.addCoSigner
);
router.post(
  '/:id/assign-quincaillerie',
  authenticate,
  validate(assignQuincaillerie),
  projectController.assignQuincaillerie
);
router.get('/:projectId/recommended-contractors', authenticate, matchingController.getRecommended);
router.get('/:projectId/bids-with-scores', authenticate, matchingController.getBidsWithScores);
router.post('/:id/fund', authenticate, idempotent, validate(fundProject), projectController.fundProject);

router.post(
  '/:id/milestones/:milestoneId/evidence',
  authenticate,
  upload.single('file'),
  validate(submitEvidence),
  projectController.submitEvidence
);
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
