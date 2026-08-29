const { Router } = require('express');
const referralController = require('../controllers/referralController');
const { authenticate, requireRole, requireAdminPermission } = require('../middleware/auth');

const router = Router();

router.get('/', authenticate, referralController.getMine);
router.post('/', authenticate, referralController.create);
router.post('/:id/claim', authenticate, referralController.claim);
router.delete('/:id', authenticate, requireRole('admin'), requireAdminPermission('community'), referralController.remove);

module.exports = router;
