const { Router } = require('express');
const visitRequestController = require('../controllers/visitRequestController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { requestVisit, confirmVisit } = require('../validators/visitRequestValidators');

const router = Router();

router.get('/', authenticate, visitRequestController.getAll);
router.post('/', authenticate, validate(requestVisit), visitRequestController.request);
router.post('/:id/confirm', authenticate, validate(confirmVisit), visitRequestController.confirm);
router.post('/:id/complete', authenticate, visitRequestController.complete);
router.post('/:id/cancel', authenticate, visitRequestController.cancel);

module.exports = router;
