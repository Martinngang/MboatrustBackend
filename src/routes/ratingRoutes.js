const { Router } = require('express');
const ratingController = require('../controllers/ratingController');
const { authenticate, requireRole, requireAdminPermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createRating, adminCreateRating, adminUpdateRating } = require('../validators/ratingValidators');

const router = Router();

router.get('/', ratingController.getAll);
router.get('/summary/:userId', ratingController.getSummary);
router.post('/', authenticate, validate(createRating), ratingController.create);
router.post('/admin', authenticate, requireRole('admin'), requireAdminPermission('verifications'), validate(adminCreateRating), ratingController.adminCreate);
router.patch('/:id', authenticate, requireRole('admin'), requireAdminPermission('verifications'), validate(adminUpdateRating), ratingController.adminUpdate);
router.delete('/:id', authenticate, requireRole('admin'), requireAdminPermission('verifications'), ratingController.remove);

module.exports = router;
