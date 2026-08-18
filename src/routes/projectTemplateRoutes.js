const { Router } = require('express');
const controller = require('../controllers/projectTemplateController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { create } = require('../validators/projectTemplateValidators');

const router = Router();

router.get('/mine', authenticate, controller.getMine);
router.post('/', authenticate, validate(create), controller.create);
router.delete('/:id', authenticate, controller.remove);

module.exports = router;
