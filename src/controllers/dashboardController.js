const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { ROLE_BUILDERS } = require('../services/dashboardStatsService');

/** GET /dashboard/:role — the signed-in user's own numbers for one role's
 * home dashboard. Always computed for `req.user`; there is deliberately no
 * user-id parameter, so no caller can read anyone else's dashboard. Every
 * figure is the caller's own data, so a user viewing a role they don't
 * (yet) hold simply gets zeros rather than an error — the same thing an
 * approval-pending supplier/verifier's own screens already expect. */
const getForRole = catchAsync(async (req, res) => {
  const build = ROLE_BUILDERS[req.params.role];
  if (!build) throw ApiError.badRequest(`Unknown dashboard role "${req.params.role}"`);
  const data = await build(req.user);
  return ok(res, data);
});

module.exports = { getForRole };
