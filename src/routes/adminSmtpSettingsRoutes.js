const { Router } = require('express');
const adminSmtpSettingsController = require('../controllers/adminSmtpSettingsController');
const { authenticate, requireRole, requireAdminPermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { updateSmtpSettings, sendTestEmail } = require('../validators/smtpSettingsValidators');

const router = Router();

// 'settings' is the same permission key feeConfigRoutes.js already gates
// platform-wide config behind — SMTP credentials belong in that category,
// not a narrower/new one.
router.use(authenticate, requireRole('admin'), requireAdminPermission('settings'));

router.get('/', adminSmtpSettingsController.getSettings);
router.put('/', validate(updateSmtpSettings), adminSmtpSettingsController.updateSettings);
router.post('/test', validate(sendTestEmail), adminSmtpSettingsController.sendTestEmail);

module.exports = router;
