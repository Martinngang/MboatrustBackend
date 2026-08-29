const { Router } = require('express');
const escrowController = require('../controllers/escrowController');
const { authenticate, requireRole, requireAdminPermission } = require('../middleware/auth');
const idempotent = require('../middleware/idempotency');
const validate = require('../middleware/validate');
const { adminCreateEscrow, adminUpdateEscrow, adminDeleteEscrow } = require('../validators/escrowValidators');

const router = Router();

router.get('/', authenticate, escrowController.getAll);
router.get('/withdrawable', authenticate, escrowController.getWithdrawable);
router.post('/withdraw', authenticate, idempotent, escrowController.withdraw);
router.get('/:id', authenticate, escrowController.getOne);
router.post('/:id/refund', authenticate, requireRole('admin'), idempotent, escrowController.refund);
router.post('/:id/refresh-status', authenticate, escrowController.refreshStatus);
router.post('/', authenticate, requireRole('admin'), requireAdminPermission('projects'), validate(adminCreateEscrow), escrowController.adminCreate);
router.patch('/:id', authenticate, requireRole('admin'), requireAdminPermission('projects'), validate(adminUpdateEscrow), escrowController.adminUpdate);
router.delete('/:id', authenticate, requireRole('admin'), requireAdminPermission('projects'), validate(adminDeleteEscrow), escrowController.adminRemove);

module.exports = router;
