const { Router } = require('express');
const adminEmailLogController = require('../controllers/adminEmailLogController');
const { authenticate, requireRole } = require('../middleware/auth');

const router = Router();

router.get('/', authenticate, requireRole('admin'), adminEmailLogController.getAll);
router.get('/summary', authenticate, requireRole('admin'), adminEmailLogController.getSummary);

module.exports = router;
