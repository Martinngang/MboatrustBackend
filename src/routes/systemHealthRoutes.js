const { Router } = require('express');
const healthController = require('../controllers/healthController');
const { authenticate, requireRole } = require('../middleware/auth');

const router = Router();

router.get('/', authenticate, requireRole('admin'), healthController.getSystemHealth);

module.exports = router;
