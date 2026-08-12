const { Router } = require('express');
const platformStatsController = require('../controllers/platformStatsController');
const { authenticate, requireRole } = require('../middleware/auth');

const router = Router();

router.get('/', authenticate, requireRole('admin'), platformStatsController.getPlatformStats);

module.exports = router;
