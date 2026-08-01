const { Router } = require('express');
const messageController = require('../controllers/messageController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { sendMessage } = require('../validators/messagingValidators');

const router = Router({ mergeParams: true });

router.get('/', authenticate, messageController.getAll);
router.post('/', authenticate, validate(sendMessage), messageController.create);

module.exports = router;
