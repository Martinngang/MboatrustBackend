const { Router } = require('express');
const messageController = require('../controllers/messageController');
const { authenticate } = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = Router({ mergeParams: true });

router.get('/', authenticate, messageController.getAll);
router.post('/', authenticate, messageController.create);

// Action routes on specific messages & uploads
const actionRouter = Router();
actionRouter.post('/direct', authenticate, messageController.createDirect);
actionRouter.post('/upload', authenticate, upload.single('file'), messageController.uploadAttachment);
actionRouter.patch('/:id', authenticate, messageController.edit);
actionRouter.post('/:id/react', authenticate, messageController.react);
actionRouter.delete('/:id', authenticate, messageController.remove);

module.exports = { router, actionRouter };
