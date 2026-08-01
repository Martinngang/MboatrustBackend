const { Router } = require('express');
const verificationController = require('../controllers/verificationController');
const { authenticate, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const {
  createVerificationTask,
  submitVerificationReport,
} = require('../validators/verificationValidators');

const router = Router();

router.get('/', authenticate, verificationController.getAll);
router.get('/:id', authenticate, verificationController.getOne);
router.post(
  '/',
  authenticate,
  requireRole('admin'),
  validate(createVerificationTask),
  verificationController.create
);
router.post('/:id/start', authenticate, requireRole('verifier'), verificationController.startTask);
router.post(
  '/:id/report',
  authenticate,
  requireRole('verifier'),
  validate(submitVerificationReport),
  verificationController.submitReport
);

module.exports = router;
