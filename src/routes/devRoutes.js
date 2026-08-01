const { Router } = require('express');
const devController = require('../controllers/devController');

const router = Router();

router.get('/demo-user', devController.getOrCreateDemoUser);

module.exports = router;
