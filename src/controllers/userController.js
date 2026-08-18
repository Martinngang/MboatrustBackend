const { User, Project, LandListing, LandOffer, Bid, Rating, ContractorProfile, Conversation, Message, Dispute, Notification, Referral } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { buildCrud } = require('./controllerFactory');
const storageService = require('../services/storageService');
const { initFirebase } = require('../config/firebase');

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

const uploadAvatar = catchAsync(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Provide a file');
  const result = await storageService.uploadBuffer(req.file.buffer, {
    folder: `mboatrust/avatars/${req.user._id}`,
  });
  const user = await User.findByIdAndUpdate(req.user._id, { avatarUrl: result.secure_url }, { new: true });
  return ok(res, user);
});

// Generic document upload — same underlying storageService.uploadBuffer as
// uploadAvatar, just returns the URL instead of writing it onto the user.
// The frontend passes the returned url straight into the KYC submit call's
// existing `documentUrl` field rather than this route being KYC-specific.
const uploadDocument = catchAsync(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Provide a file');
  const result = await storageService.uploadBuffer(req.file.buffer, {
    folder: `mboatrust/documents/${req.user._id}`,
  });
  return ok(res, { url: result.secure_url });
});

const setDeviceToken = catchAsync(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.user._id, { fcmDeviceToken: req.body.token }, { new: true });
  return ok(res, user);
});

/** Richer than the generic buildCrud.getAll — filters by role and isActive
 * too, not just kycStatus, since an admin user-list needs both. Never
 * mounted without an admin gate (see routes/userRoutes.js). */
const adminGetAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, role, kycStatus, isActive } = req.query;
  const filter = {};
  if (role) filter['roles.roleType'] = role;
  if (kycStatus) filter.kycStatus = kycStatus;
  if (isActive !== undefined) filter.isActive = isActive === 'true';

  const [items, total] = await Promise.all([
    User.find(filter).sort('-createdAt').skip((page - 1) * limit).limit(Number(limit)),
    User.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const adminGetOne = catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');
  return ok(res, user);
});

/** Soft status flip, not a hard delete — every other destructive-feeling
 * action in this codebase (bids, disputes, contracts) works the same way,
 * and a User has too much linked data (projects, bids, escrows) to ever
 * really delete outright. */
const deactivate = catchAsync(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  if (!user) throw ApiError.notFound('User not found');
  return ok(res, user);
});

const reactivate = catchAsync(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, { isActive: true }, { new: true });
  if (!user) throw ApiError.notFound('User not found');
  return ok(res, user);
});

const revokeRole = catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');
  user.roles = user.roles.filter((r) => r.roleType !== req.params.roleType);
  await user.save();
  return ok(res, user);
});

/** Admin-only counterpart to revokeRole/addRole — the only path onto
 * 'verifier'/'admin' now that those are excluded from the self-service
 * addRole enum (see userValidators.js). Mirrors addRole's own
 * already-has-it guard, just targeting a specific user instead of req.user. */
const grantRole = catchAsync(async (req, res) => {
  const { roleType } = req.body;
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');
  if (!user.roles.some((r) => r.roleType === roleType)) {
    user.roles.push({ roleType });
    await user.save();
  }
  return ok(res, user);
});

/** Synchronous self-service export of everything this account owns, scoped
 * strictly to req.user._id across every collection with a direct user link —
 * a real "download my data" rather than a fire-and-forget request that
 * promised an email nothing ever sent. */
const exportMyData = catchAsync(async (req, res) => {
  const uid = req.user._id;
  const conversations = await Conversation.find({ participantIds: uid }).lean();
  const [
    projects, landListings, landOffers, bids, ratingsGiven, ratingsReceived, contractorProfile,
    messages, disputesRaised, notifications, referrals,
  ] = await Promise.all([
    Project.find({ ownerId: uid }).lean(),
    LandListing.find({ sellerId: uid }).lean(),
    LandOffer.find({ buyerId: uid }).lean(),
    Bid.find({ contractorId: uid }).lean(),
    Rating.find({ fromUserId: uid }).lean(),
    Rating.find({ toUserId: uid }).lean(),
    ContractorProfile.findOne({ userId: uid }).lean(),
    Message.find({ conversationId: { $in: conversations.map((c) => c._id) } }).lean(),
    Dispute.find({ raisedBy: uid }).lean(),
    Notification.find({ userId: uid }).lean(),
    Referral.find({ $or: [{ referrerId: uid }, { referredId: uid }] }).lean(),
  ]);
  return ok(res, {
    exportedAt: new Date().toISOString(),
    profile: req.user,
    projects,
    landListings,
    landOffers,
    bids,
    ratingsGiven,
    ratingsReceived,
    contractorProfile,
    conversations,
    messages,
    disputesRaised,
    notifications,
    referrals,
  });
});

/** Real "sign out everywhere" — invalidates every Firebase refresh token
 * issued to this account, so every other signed-in device is forced to
 * re-authenticate. There is no per-device session list to select from (this
 * app never recorded one), so this revokes all sessions at once rather than
 * pretending to target a single fabricated "device". */
const revokeSessions = catchAsync(async (req, res) => {
  const admin = initFirebase();
  if (!req.user.firebaseUid || !admin) {
    return ok(res, { revoked: false, reason: 'No linked Firebase account for this user (dev session).' });
  }
  // A dev-seeded user carries a placeholder firebaseUid ("dev-...") that was
  // never actually registered with Firebase — revokeRefreshTokens would 404
  // on it, which isn't a real failure, just "nothing to revoke".
  const revoked = await admin
    .auth()
    .revokeRefreshTokens(req.user.firebaseUid)
    .then(() => true)
    .catch(() => false);
  return ok(res, { revoked });
});

/** Authenticated-only, capped-result lookup so a user can find another real
 * account to add somewhere (a co-signer, say) by name/phone/email — never a
 * public/unauthenticated directory, and never more than a handful of rows,
 * to keep this from becoming a user-enumeration tool. */
const search = catchAsync(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) throw ApiError.badRequest('Provide at least 2 characters to search');

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, 'i');
  const users = await User.find({
    _id: { $ne: req.user._id },
    $or: [{ fullName: pattern }, { email: pattern }, { phoneNumber: pattern }],
  })
    .select('fullName email phoneNumber avatarUrl roles')
    .limit(10);
  return ok(res, users);
});

const getPublicProfile = catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id).select(
    'fullName roles kycStatus kycLevel avatarUrl createdAt'
  );
  if (!user) throw ApiError.notFound('User not found');
  return ok(res, user);
});

module.exports = {
  ...crud,
  getMe,
  updateMe,
  addRole,
  linkAuthProvider,
  uploadAvatar,
  uploadDocument,
  setDeviceToken,
  exportMyData,
  revokeSessions,
  search,
  getPublicProfile,
  adminGetAll,
  adminGetOne,
  deactivate,
  reactivate,
  revokeRole,
  grantRole,
};
