const { Router } = require('express');
const platformStatsController = require('../controllers/platformStatsController');
const { authenticate, requireRole, requireAdminPermission } = require('../middleware/auth');

const router = Router();

// 'overview' is the permission key for the admin Dashboard section (see
// ADMIN_PERMISSION_KEYS) — a restricted admin without it no longer sees the
// sidebar entry, and now can't pull the numbers directly either.
router.get('/', authenticate, requireRole('admin'), requireAdminPermission('overview'), platformStatsController.getPlatformStats);

module.exports = router;
