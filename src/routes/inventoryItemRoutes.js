const { Router } = require('express');
const controller = require('../controllers/inventoryItemController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const upload = require('../middleware/upload');
const { createItem, updateItem, bulkAction } = require('../validators/inventoryItemValidators');

const router = Router();

router.get('/mine', authenticate, controller.getMine);
router.get('/public', authenticate, controller.getPublicActive);
router.get('/by-supplier/:supplierId', authenticate, controller.getBySupplier);
router.post('/bulk', authenticate, validate(bulkAction), controller.bulk);
router.get('/:id', authenticate, controller.getOne);
router.post('/', authenticate, upload.array('images', 6), validate(createItem), controller.create);
router.patch('/:id', authenticate, upload.array('images', 6), validate(updateItem), controller.update);
router.post('/:id/duplicate', authenticate, controller.duplicate);
router.post('/:id/archive', authenticate, controller.archive);
router.post('/:id/restore', authenticate, controller.restore);
router.delete('/:id', authenticate, controller.remove);

module.exports = router;
