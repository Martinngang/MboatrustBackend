// Mounted at /admin/conversations — separate from conversationRoutes.js
// because that router's `GET /` is already `getMine` (self-scoped for the
// consumer app); this is the metadata-only admin oversight list. See
// conversationController.adminGetAll for exactly what it does and does not
// expose (no message bodies, ever).
const { Router } = require('express');
const conversationController = require('../controllers/conversationController');
const { authenticate, requireRole, requireAdminPermission } = require('../middleware/auth');

const router = Router();

router.get('/', authenticate, requireRole('admin'), requireAdminPermission('verifications'), conversationController.adminGetAll);

module.exports = router;
