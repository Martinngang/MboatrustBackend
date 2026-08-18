const catchAsync = require('../utils/catchAsync');
const { created } = require('../utils/apiResponse');
const { resolveUser } = require('../middleware/auth');
const { logEvent } = require('../services/systemEventService');

/**
 * Unauthenticated on purpose — a pre-login crash (the landing page, sign-in
 * screen itself) must still be reportable, mitigated by the existing global
 * rate limiter (see app.js) rather than an auth requirement. Best-effort
 * attributes the event to a real user when a valid token/dev-bypass header
 * happens to be present (resolveUser never throws), otherwise userId stays
 * null — never blocks the report either way.
 */
const create = catchAsync(async (req, res) => {
  const user = await resolveUser({
    authHeader: req.headers.authorization,
    devUserId: req.headers['x-dev-user-id'],
  }).catch(() => null);

  const event = await logEvent({
    type: req.body.type,
    severity: 'error',
    source: req.body.source,
    detail: req.body.detail,
    userId: user?._id || null,
  });
  return created(res, event);
});

module.exports = { create };
