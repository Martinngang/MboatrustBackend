const { Router } = require('express');
const toolsController = require('../controllers/toolsController');

const router = Router();

router.get('/convert', toolsController.convert);

module.exports = router;
