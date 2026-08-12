const { Router } = require('express');
const userController = require('../controllers/userController');
const { authenticate, requireRole } = require('../middleware/auth');

const router = Router();

router.use(authenticate, requireRole('admin'));
router.get('/', userController.adminGetAll);
router.get('/:id', userController.adminGetOne);
router.patch('/:id/deactivate', userController.deactivate);
router.patch('/:id/reactivate', userController.reactivate);
router.delete('/:id/roles/:roleType', userController.revokeRole);

module.exports = router;
