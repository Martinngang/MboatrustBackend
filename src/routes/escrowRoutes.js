const { Router } = require('express');
const escrowController = require('../controllers/escrowController');
const { authenticate, requireRole } = require('../middleware/auth');
const idempotent = require('../middleware/idempotency');

const router = Router();

router.get('/', authenticate, requireRole('admin'), escrowController.getAll);
router.get('/:id', authenticate, escrowController.getOne);
router.post('/:id/refund', authenticate, requireRole('admin'), idempotent, escrowController.refund);
router.post('/:id/refresh-status', authenticate, escrowController.refreshStatus);

module.exports = router;
