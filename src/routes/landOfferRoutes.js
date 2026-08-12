const { Router } = require('express');
const landOfferController = require('../controllers/landOfferController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createOffer, counterOffer } = require('../validators/landOfferValidators');

const router = Router();

router.get('/', authenticate, landOfferController.getAll);
router.post('/', authenticate, validate(createOffer), landOfferController.create);
router.post('/:id/counter', authenticate, validate(counterOffer), landOfferController.counter);
router.post('/:id/accept', authenticate, landOfferController.accept);
router.post('/:id/decline', authenticate, landOfferController.decline);
router.post('/:id/withdraw', authenticate, landOfferController.withdraw);

module.exports = router;
