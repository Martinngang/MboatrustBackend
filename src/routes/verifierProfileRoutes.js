const { Router } = require('express');
const controller = require('../controllers/verifierProfileController');
const { authenticate, requireRole, requireAdminPermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const upload = require('../middleware/upload');
const { upsertMine } = require('../validators/verifierProfileValidators');

const router = Router();

router.get('/me', authenticate, controller.getMine);
router.post('/me', authenticate, upload.single('file'), validate(upsertMine), controller.upsertMine);
router.get('/', authenticate, requireRole('admin'), controller.getAll);
router.post('/:id/approve', authenticate, requireRole('admin'), controller.approve);
router.post('/:id/reject', authenticate, requireRole('admin'), controller.reject);
router.patch('/:userId', authenticate, requireRole('admin'), requireAdminPermission('verifications'), validate(upsertMine), controller.adminUpdate);

module.exports = router;
