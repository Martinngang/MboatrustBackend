const { Router } = require('express');
const controller = require('../controllers/materialOrderController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const {
  createMaterialOrder,
  confirmMaterialOrder,
  rejectMaterialOrder,
  confirmDelivery,
} = require('../validators/materialOrderValidators');

const router = Router();

router.post('/', authenticate, validate(createMaterialOrder), controller.create);
router.get('/mine', authenticate, controller.getMine);
router.get('/for-supplier', authenticate, controller.getForMySupplier);
router.get('/projects/:projectId/milestones/:milestoneId', authenticate, controller.getForMilestone);
router.post('/:id/confirm', authenticate, validate(confirmMaterialOrder), controller.confirm);
router.post('/:id/reject', authenticate, validate(rejectMaterialOrder), controller.reject);
router.post('/:id/out-for-delivery', authenticate, controller.markOutForDelivery);
router.post('/:id/confirm-delivery', authenticate, validate(confirmDelivery), controller.confirmDelivery);
router.post('/:id/cancel', authenticate, controller.cancel);

module.exports = router;
