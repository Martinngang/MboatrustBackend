const { Router } = require('express');
const feeConfigController = require('../controllers/feeConfigController');
const { authenticate, requireRole, requireAdminPermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { upsertFeeConfig } = require('../validators/feeConfigValidators');

const router = Router();

router.get('/', feeConfigController.getAll);
router.get('/:feeType', feeConfigController.getByType);
router.put('/', authenticate, requireRole('admin'), requireAdminPermission('settings'), validate(upsertFeeConfig), feeConfigController.upsert);
router.delete('/:feeType', authenticate, requireRole('admin'), requireAdminPermission('settings'), feeConfigController.remove);

module.exports = router;
