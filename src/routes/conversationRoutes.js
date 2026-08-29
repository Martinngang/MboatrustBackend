const { Router } = require('express');
const conversationController = require('../controllers/conversationController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createConversation } = require('../validators/messagingValidators');
const { router: messageRouter } = require('./messageRoutes');

const router = Router();

router.get('/', authenticate, conversationController.getMine);
router.get('/direct/:userId', authenticate, conversationController.getWithUser);
router.get('/:id', authenticate, conversationController.getOne);
router.post('/', authenticate, conversationController.create); // Simplified validation
router.post('/:id/read', authenticate, conversationController.markRead);

router.use('/:conversationId/messages', messageRouter);

module.exports = router;
