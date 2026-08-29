// Consolidates the admin-only "list everything" endpoints for the
// Community & Funding entities whose root path is already taken by a
// self-scoped consumer route (referrals' and subscriptions' `GET /` are
// each `getMine`) — mirrors the `/admin/xxx` prefix convention used by
// platformStatsRoutes.js / adminActivityRoutes.js rather than colliding
// with those. Group's own admin list didn't have this conflict (no
// existing `GET /` on groupRoutes.js) so it's mounted directly there
// instead — see routes/groupRoutes.js.
const { Router } = require('express');
const referralController = require('../controllers/referralController');
const subscriptionController = require('../controllers/subscriptionController');
const teamMemberController = require('../controllers/teamMemberController');
const { authenticate, requireRole, requireAdminPermission } = require('../middleware/auth');

const router = Router();

router.use(authenticate, requireRole('admin'), requireAdminPermission('community'));
router.get('/referrals', referralController.getAll);
router.get('/subscriptions', subscriptionController.getAll);
router.get('/team-members', teamMemberController.getAll);

module.exports = router;
