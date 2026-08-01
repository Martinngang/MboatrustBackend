const { Router } = require('express');
const conversationController = require('../controllers/conversationController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createConversation } = require('../validators/messagingValidators');
const messageRoutes = require('./messageRoutes');

const router = Router();

router.get('/', authenticate, conversationController.getMine);
router.get('/:id', authenticate, conversationController.getOne);
router.post('/', authenticate, validate(createConversation), conversationController.create);

router.use('/:conversationId/messages', messageRoutes);

module.exports = router;
