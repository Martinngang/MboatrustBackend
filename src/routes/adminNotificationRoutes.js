const { Router } = require('express');
const adminNotificationController = require('../controllers/adminNotificationController');
const { authenticate, requireRole, requireAdminPermission } = require('../middleware/auth');

const router = Router();

router.use(authenticate, requireRole('admin'), requireAdminPermission('notifications'));
router.post('/broadcast', adminNotificationController.broadcast);
router.get('/', adminNotificationController.getAll);

module.exports = router;
