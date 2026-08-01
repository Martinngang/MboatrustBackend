const { Router } = require('express');
const bidController = require('../controllers/bidController');
const { authenticate, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const idempotent = require('../middleware/idempotency');
const { createBid, updateBidStatus } = require('../validators/bidValidators');

const router = Router();

router.get('/', bidController.getAll);
router.get('/:id', bidController.getOne);
router.post('/', authenticate, requireRole('contractor'), validate(createBid), bidController.create);
// Idempotency-protected: accepting a bid creates a Contract as a side effect —
// a duplicate submit (double-tap, network retry) must not create two.
router.patch('/:id/status', authenticate, idempotent, validate(updateBidStatus), bidController.updateStatus);

module.exports = router;
