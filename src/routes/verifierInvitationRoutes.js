const { Router } = require('express');
const controller = require('../controllers/verifierInvitationController');
const { authenticate } = require('../middleware/auth');

const router = Router();

// Public — no auth. Lets the web accept page (#/verifier-invite/:token)
// render project/funder context before or during signup.
router.get('/:token', controller.getInvitationPreview);
// Authenticated — any signed-in user (new or existing). See
// verifierInvitationController.acceptInvitation for the full validation
// chain (expiry, status, self-invite guard).
router.post('/:token/accept', authenticate, controller.acceptInvitation);

module.exports = router;
