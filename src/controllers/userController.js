const { User } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { buildCrud } = require('./controllerFactory');

const crud = buildCrud(User, { searchableFilters: ['kycStatus'] });

const getMe = catchAsync(async (req, res) => {
  return ok(res, req.user);
});

const updateMe = catchAsync(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.user._id, req.body, {
    new: true,
    runValidators: true,
  });
  return ok(res, user);
});

const addRole = catchAsync(async (req, res) => {
  const { roleType } = req.body;
  const user = await User.findById(req.user._id);
  if (!user.roles.some((r) => r.roleType === roleType)) {
    user.roles.push({ roleType });
    await user.save();
  }
  return ok(res, user);
});

const linkAuthProvider = catchAsync(async (req, res) => {
  const { provider, providerId } = req.body;
  const user = await User.findById(req.user._id);
  if (!user.authProviders.some((p) => p.provider === provider)) {
    user.authProviders.push({ provider, providerId });
    await user.save();
  }
  return ok(res, user);
});

const getPublicProfile = catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id).select(
    'fullName roles kycStatus kycLevel avatarUrl createdAt'
  );
  if (!user) throw ApiError.notFound('User not found');
  return ok(res, user);
});

module.exports = { ...crud, getMe, updateMe, addRole, linkAuthProvider, getPublicProfile };
