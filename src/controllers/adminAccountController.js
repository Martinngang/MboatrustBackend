const { User } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { logAdminAction } = require('../services/adminActionLogService');

const getAll = catchAsync(async (req, res) => {
  const admins = await User.find({ 'roles.roleType': 'admin' })
    .select('fullName email phoneNumber adminPermissions isActive createdAt')
    .sort('-createdAt');
  return ok(res, admins);
});

// Only reachable by an unrestricted admin (see requireUnrestrictedAdmin in
// middleware/auth.js) — a restricted admin can never escalate via this
// route, even targeting themselves.
const setPermissions = catchAsync(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) throw ApiError.notFound('User not found');
  if (!target.roles.some((r) => r.roleType === 'admin')) {
    throw ApiError.badRequest('Permissions only apply to users with the admin role');
  }

  const { permissions } = req.body;
  target.adminPermissions = permissions;
  await target.save();

  await logAdminAction({
    adminId: req.user._id,
    action: 'admin.setPermissions',
    targetType: 'User',
    targetId: target._id,
    detail: { permissions },
  });

  return ok(res, {
    id: target._id,
    fullName: target.fullName,
    email: target.email,
    adminPermissions: target.adminPermissions,
  });
});

module.exports = { getAll, setPermissions };
