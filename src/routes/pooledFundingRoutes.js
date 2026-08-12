const { Router } = require('express');
const pooledFundingController = require('../controllers/pooledFundingController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { invite, contribute } = require('../validators/pooledFundingValidators');

const router = Router();

router.get('/', authenticate, pooledFundingController.getAll);
router.post('/invite', authenticate, validate(invite), pooledFundingController.invite);
router.post('/contribute', authenticate, validate(contribute), pooledFundingController.contribute);
router.post('/:id/cancel-recurring', authenticate, pooledFundingController.cancelRecurring);
router.post('/:id/pause-recurring', authenticate, pooledFundingController.pauseRecurring);
router.post('/:id/resume-recurring', authenticate, pooledFundingController.resumeRecurring);

module.exports = router;
