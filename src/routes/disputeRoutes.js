const { Router } = require('express');
const disputeController = require('../controllers/disputeController');
const { authenticate, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createDispute, resolveDispute } = require('../validators/disputeValidators');

const router = Router();

router.get('/', authenticate, disputeController.getAll);
router.get('/:id', authenticate, disputeController.getOne);
router.post('/', authenticate, validate(createDispute), disputeController.create);
router.patch(
  '/:id/resolve',
  authenticate,
  requireRole('admin'),
  validate(resolveDispute),
  disputeController.resolve
);

module.exports = router;
