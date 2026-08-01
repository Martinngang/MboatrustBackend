const { Router } = require('express');
const ratingController = require('../controllers/ratingController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createRating } = require('../validators/ratingValidators');

const router = Router();

router.get('/', ratingController.getAll);
router.get('/summary/:userId', ratingController.getSummary);
router.post('/', authenticate, validate(createRating), ratingController.create);

module.exports = router;
