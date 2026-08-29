const { Router } = require('express');
const adminActivityController = require('../controllers/adminActivityController');
const { authenticate, requireRole } = require('../middleware/auth');

const router = Router();

router.get('/', authenticate, requireRole('admin'), adminActivityController.getAll);

module.exports = router;
