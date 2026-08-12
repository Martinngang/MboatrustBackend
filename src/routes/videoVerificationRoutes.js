const { Router } = require('express');
const videoVerificationController = require('../controllers/videoVerificationController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { requestSession, scheduleSession, completeSession } = require('../validators/videoVerificationValidators');

const router = Router();

router.get('/', authenticate, videoVerificationController.getAll);
router.post('/', authenticate, validate(requestSession), videoVerificationController.request);
router.post('/:id/schedule', authenticate, validate(scheduleSession), videoVerificationController.schedule);
router.post('/:id/complete', authenticate, validate(completeSession), videoVerificationController.complete);
router.post('/:id/cancel', authenticate, videoVerificationController.cancel);

module.exports = router;
