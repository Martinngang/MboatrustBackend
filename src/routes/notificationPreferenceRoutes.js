const { Router } = require('express');
const controller = require('../controllers/notificationPreferenceController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { updatePrefs } = require('../validators/notificationPreferenceValidators');

const router = Router();

router.get('/me', authenticate, controller.getMine);
router.put('/me', authenticate, validate(updatePrefs), controller.updateMine);

module.exports = router;
