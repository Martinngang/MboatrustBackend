const { Router } = require('express');
const adminAccountController = require('../controllers/adminAccountController');
const { authenticate, requireRole, requireAdminPermission, requireUnrestrictedAdmin } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { setPermissions } = require('../validators/adminAccountValidators');

const router = Router();

router.use(authenticate, requireRole('admin'), requireAdminPermission('admins'));
router.get('/', adminAccountController.getAll);
router.post('/:id/permissions', requireUnrestrictedAdmin, validate(setPermissions), adminAccountController.setPermissions);

module.exports = router;
