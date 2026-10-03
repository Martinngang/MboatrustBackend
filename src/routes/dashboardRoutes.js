const { Router } = require('express');
const dashboardController = require('../controllers/dashboardController');
const { authenticate } = require('../middleware/auth');

const router = Router();

router.get('/:role', authenticate, dashboardController.getForRole);

module.exports = router;
