const { Router } = require('express');
const activityController = require('../controllers/activityController');
const { authenticate } = require('../middleware/auth');

const router = Router();

router.get('/mine', authenticate, activityController.getMine);

module.exports = router;
