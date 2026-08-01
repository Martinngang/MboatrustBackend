const { Router } = require('express');
const userController = require('../controllers/userController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { updateProfile, addRole, linkAuthProvider } = require('../validators/userValidators');

const router = Router();

router.get('/me', authenticate, userController.getMe);
router.patch('/me', authenticate, validate(updateProfile), userController.updateMe);
router.post('/me/roles', authenticate, validate(addRole), userController.addRole);
router.post('/me/auth-providers', authenticate, validate(linkAuthProvider), userController.linkAuthProvider);

router.get('/:id', userController.getPublicProfile);

module.exports = router;
