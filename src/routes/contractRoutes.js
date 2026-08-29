const { Router } = require('express');
const contractController = require('../controllers/contractController');
const { authenticate, requireRole, requireAdminPermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { adminCreateContract, adminUpdateContract } = require('../validators/contractValidators');

const router = Router();

router.get('/', authenticate, contractController.getAll);
router.get('/:id', authenticate, contractController.getOne);
router.post('/:id/complete', authenticate, contractController.markCompleted);
router.post('/:id/terminate', authenticate, contractController.terminate);
router.post('/', authenticate, requireRole('admin'), requireAdminPermission('contractors'), validate(adminCreateContract), contractController.adminCreate);
router.patch('/:id', authenticate, requireRole('admin'), requireAdminPermission('contractors'), validate(adminUpdateContract), contractController.adminUpdate);
router.delete('/:id', authenticate, requireRole('admin'), requireAdminPermission('contractors'), contractController.adminRemove);

module.exports = router;
