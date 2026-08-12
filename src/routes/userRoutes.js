const { Router } = require('express');
const { z } = require('zod');
const userController = require('../controllers/userController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const upload = require('../middleware/upload');
const { updateProfile, addRole, linkAuthProvider } = require('../validators/userValidators');

const router = Router();

router.get('/me', authenticate, userController.getMe);
router.patch('/me', authenticate, validate(updateProfile), userController.updateMe);
router.post('/me/roles', authenticate, validate(addRole), userController.addRole);
router.post('/me/auth-providers', authenticate, validate(linkAuthProvider), userController.linkAuthProvider);
router.post('/me/avatar', authenticate, upload.single('file'), userController.uploadAvatar);
router.post('/me/documents', authenticate, upload.single('file'), userController.uploadDocument);
router.post('/me/device-token', authenticate, validate(z.object({ token: z.string().min(1) })), userController.setDeviceToken);
router.get('/me/export', authenticate, userController.exportMyData);
router.post('/me/sessions/revoke', authenticate, userController.revokeSessions);

router.get('/search', authenticate, userController.search);
router.get('/:id', userController.getPublicProfile);

module.exports = router;
