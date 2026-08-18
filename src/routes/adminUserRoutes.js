const { Router } = require('express');
const userController = require('../controllers/userController');
const { authenticate, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { adminGrantRole } = require('../validators/userValidators');

const router = Router();

router.use(authenticate, requireRole('admin'));
router.get('/', userController.adminGetAll);
router.get('/:id', userController.adminGetOne);
router.patch('/:id/deactivate', userController.deactivate);
router.patch('/:id/reactivate', userController.reactivate);
router.post('/:id/roles', validate(adminGrantRole), userController.grantRole);
router.delete('/:id/roles/:roleType', userController.revokeRole);

module.exports = router;
