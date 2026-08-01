const { Router } = require('express');
const subscriptionController = require('../controllers/subscriptionController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createSubscription } = require('../validators/subscriptionValidators');

const router = Router();

router.get('/', authenticate, subscriptionController.getMine);
router.post('/', authenticate, validate(createSubscription), subscriptionController.create);
router.patch('/:id/cancel', authenticate, subscriptionController.cancel);

module.exports = router;
