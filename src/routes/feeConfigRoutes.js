const { Router } = require('express');
const feeConfigController = require('../controllers/feeConfigController');
const { authenticate, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { upsertFeeConfig } = require('../validators/feeConfigValidators');

const router = Router();

router.get('/', feeConfigController.getAll);
router.get('/:feeType', feeConfigController.getByType);
router.put('/', authenticate, requireRole('admin'), validate(upsertFeeConfig), feeConfigController.upsert);

module.exports = router;
