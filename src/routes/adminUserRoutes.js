const { Router } = require('express');
const userController = require('../controllers/userController');
const { authenticate, requireRole, requireAdminPermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { adminGrantRole, adminCreateUser, adminUpdateUser, deleteMyAccount, adminChangePassword } = require('../validators/userValidators');

const router = Router();

router.use(authenticate, requireRole('admin'), requireAdminPermission('users'));
router.get('/', userController.adminGetAll);
router.post('/', validate(adminCreateUser), userController.adminCreate);
router.get('/:id', userController.adminGetOne);
router.patch('/:id', validate(adminUpdateUser), userController.adminUpdate);
router.delete('/:id', validate(deleteMyAccount), userController.adminDelete);
// TEMPORARY — see userController.adminChangePassword's comment.
router.post('/:id/password', validate(adminChangePassword), userController.adminChangePassword);
router.patch('/:id/deactivate', userController.deactivate);
router.patch('/:id/reactivate', userController.reactivate);
router.post('/:id/roles', validate(adminGrantRole), userController.grantRole);
router.delete('/:id/roles/:roleType', userController.revokeRole);

module.exports = router;
