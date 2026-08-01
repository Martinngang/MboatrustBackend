const { Router } = require('express');
const referralController = require('../controllers/referralController');
const { authenticate } = require('../middleware/auth');

const router = Router();

router.get('/', authenticate, referralController.getMine);
router.post('/', authenticate, referralController.create);
router.post('/:id/claim', authenticate, referralController.claim);

module.exports = router;
