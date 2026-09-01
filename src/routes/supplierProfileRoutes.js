const { Router } = require('express');
const controller = require('../controllers/supplierProfileController');
const { authenticate, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { upsertMine } = require('../validators/supplierProfileValidators');

const router = Router();

router.get('/me', authenticate, controller.getMine);
router.post('/me', authenticate, validate(upsertMine), controller.upsertMine);
router.get('/directory', authenticate, controller.getDirectory);
router.get('/', authenticate, requireRole('admin'), controller.getAll);
router.post('/:id/approve', authenticate, requireRole('admin'), controller.approve);
router.post('/:id/reject', authenticate, requireRole('admin'), controller.reject);

module.exports = router;
