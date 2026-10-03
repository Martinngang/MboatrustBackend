const { Router } = require('express');
const toolsController = require('../controllers/toolsController');

const router = Router();

router.get('/convert', toolsController.convert);
router.get('/reverse-geocode', toolsController.reverseGeocode);
router.get('/geocode', toolsController.geocode);

module.exports = router;
