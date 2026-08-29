const { User, Project, LandListing, LandOffer, Bid, Rating, ContractorProfile, Conversation, Message, Dispute, Notification, Referral } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { buildCrud } = require('./controllerFactory');
const storageService = require('../services/storageService');
const { initFirebase } = require('../config/firebase');
const { hardDeleteUser } = require('../services/userDeletionService');
const { logAdminAction } = require('../services/adminActionLogService');

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
  const { page = 1, limit = 20, role, kycStatus, isActive, search } = req.query;
  const filter = {};
  if (role) filter['roles.roleType'] = role;
  if (kycStatus) filter.kycStatus = kycStatus;
  if (isActive !== undefined) filter.isActive = isActive === 'true';
  if (search) {
    const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    filter.$or = [{ fullName: pattern }, { email: pattern }, { phoneNumber: pattern }];
  }

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

/** Admin-created account — no firebaseUid yet; the real person links it on
 * their first actual Firebase sign-in (see middleware/auth.js's
 * resolveUser, which now matches by email for exactly this case instead of
 * JIT-provisioning a duplicate). */
const adminCreate = catchAsync(async (req, res) => {
  const { fullName, email, phoneNumber, roles } = req.body;
  const user = await User.create({
    fullName,
    email,
    phoneNumber,
    roles: (roles || []).map((roleType) => ({ roleType })),
  });
  await logAdminAction({ adminId: req.user._id, action: 'user.create', targetType: 'User', targetId: user._id, detail: { email, roles } });
  return ok(res, user, undefined, 201);
});

/** Strict-validator-gated (see validators/userValidators.js's
 * adminUpdateUser) — never a raw passthrough. Reuses the same
 * findByIdAndUpdate shape as buildCrud's generic `update`, just under an
 * admin-only route with its own validator instead of that unrouted one. */
const adminUpdate = catchAsync(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!user) throw ApiError.notFound('User not found');
  await logAdminAction({ adminId: req.user._id, action: 'user.update', targetType: 'User', targetId: user._id, detail: { fields: Object.keys(req.body) } });
  return ok(res, user);
});

/** Admin-only — sets a user's Firebase Auth password directly, via the
 * Firebase Admin SDK (never touches User.passwordHash, which is unused for
 * any real auth flow — Firebase is the actual identity provider). Only
 * works for a user with a real linked Firebase account; a dev-seeded
 * placeholder firebaseUid (or no Firebase project configured at all) fails
 * cleanly with a clear reason rather than silently no-op'ing, since
 * "change the password" has no meaningful partial-success outcome the way
 * revokeSessions's best-effort semantics do.
 *
 * TEMPORARY: the user asked for this to be added now and removed later —
 * do not treat this as a permanent part of the admin surface. */
const adminChangePassword = catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  const admin = initFirebase();
  if (!user.firebaseUid || !admin) {
    throw ApiError.badRequest('This account has no linked Firebase identity to set a password on');
  }
  // devController.js's DEV_AUTH_BYPASS demo users (and any other dev-seeded
  // account created the same way) are stamped with the literal `dev-<role>`
  // placeholder as firebaseUid — never a real Firebase Auth UID — so
  // updateUser() below would always 404 with Firebase's own confusing
  // "no user record corresponding to the provided identifier" instead of
  // explaining why. Catch it here with the real reason instead.
  if (user.firebaseUid.startsWith('dev-')) {
    throw ApiError.badRequest('This is a dev/demo account with no real Firebase identity — its password can\'t be changed this way.');
  }

  await admin
    .auth()
    .updateUser(user.firebaseUid, { password: req.body.newPassword })
    .catch((err) => {
      if (err.code === 'auth/user-not-found') {
        throw ApiError.badRequest('This account\'s Firebase identity no longer exists (it may have been deleted directly in Firebase) — password can\'t be changed.');
      }
      throw ApiError.badRequest(`Could not update the password: ${err.message}`);
    });

  await logAdminAction({ adminId: req.user._id, action: 'user.changePassword', targetType: 'User', targetId: user._id, detail: { email: user.email } });
  return ok(res, { success: true });
});

/** Real hard delete of ANY user, unlike deleteMe (self only) — reuses the
 * exact same userDeletionService.hardDeleteUser, same {confirm:'DELETE'}
 * gate as the self-service path. */
const adminDelete = catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');
  const email = user.email;
  const result = await hardDeleteUser(req.params.id);
  await logAdminAction({ adminId: req.user._id, action: 'user.delete', targetType: 'User', targetId: req.params.id, detail: { email } });
  return ok(res, result);
});

/** Soft status flip, not a hard delete — every other destructive-feeling
 * action in this codebase (bids, disputes, contracts) works the same way,
 * and a User has too much linked data (projects, bids, escrows) to ever
 * really delete outright. */
const deactivate = catchAsync(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  if (!user) throw ApiError.notFound('User not found');
  await logAdminAction({ adminId: req.user._id, action: 'user.deactivate', targetType: 'User', targetId: user._id, detail: { email: user.email } });
  return ok(res, user);
});

/** Self-service counterpart to the admin-only deactivate — same soft
 * status flip (see deactivate's comment for why this is a deactivate, not
 * a hard delete), just targeting req.user instead of req.params.id, and
 * also revoking every Firebase session so the account is actually signed
 * out everywhere immediately rather than staying logged in on this device
 * until its token happens to expire. */
const deactivateMe = catchAsync(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.user._id, { isActive: false }, { new: true });

  const admin = initFirebase();
  if (user.firebaseUid && admin) {
    await admin.auth().revokeRefreshTokens(user.firebaseUid).catch(() => {});
  }

  return ok(res, user);
});

/** Real hard delete — irreversible, unlike deactivateMe. See
 * userDeletionService.hardDeleteUser for exactly what gets deleted vs.
 * detached. Requires the literal body {confirm:'DELETE'} (see
 * validators/userValidators.js), a second confirmation gate on top of
 * whatever the frontend already required before calling this. */
const deleteMe = catchAsync(async (req, res) => {
  const result = await hardDeleteUser(req.user._id);
  return ok(res, result);
});

const reactivate = catchAsync(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, { isActive: true }, { new: true });
  if (!user) throw ApiError.notFound('User not found');
  await logAdminAction({ adminId: req.user._id, action: 'user.reactivate', targetType: 'User', targetId: user._id, detail: { email: user.email } });
  return ok(res, user);
});

const revokeRole = catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');
  user.roles = user.roles.filter((r) => r.roleType !== req.params.roleType);
  await user.save();
  await logAdminAction({ adminId: req.user._id, action: 'user.revokeRole', targetType: 'User', targetId: user._id, detail: { roleType: req.params.roleType } });
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
    await logAdminAction({ adminId: req.user._id, action: 'user.grantRole', targetType: 'User', targetId: user._id, detail: { roleType } });
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
    isActive: true,
    'roles.roleType': { $ne: 'admin' },
    fullName: pattern, // Name search only, as requested
  })
    .select('_id fullName avatarUrl') // Minimal fields
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

// ── Payout method management ─────────────────────────────────────────────────

const addPayoutMethod = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id);
  if (user.payoutMethods.length >= 5) {
    throw new ApiError(400, 'Maximum of 5 payout methods allowed');
  }
  const { label, provider, phoneNumber } = req.body;
  const isFirst = user.payoutMethods.length === 0;
  user.payoutMethods.push({ label, provider, phoneNumber, isDefault: isFirst });
  await user.save();
  return ok(res, { payoutMethods: user.payoutMethods });
});

const removePayoutMethod = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id);
  const method = user.payoutMethods.id(req.params.methodId);
  if (!method) throw new ApiError(404, 'Payout method not found');
  const wasDefault = method.isDefault;
  user.payoutMethods.pull({ _id: req.params.methodId });
  if (wasDefault && user.payoutMethods.length > 0) {
    user.payoutMethods[0].isDefault = true;
  }
  await user.save();
  return ok(res, { payoutMethods: user.payoutMethods });
});

const setDefaultPayoutMethod = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id);
  const method = user.payoutMethods.id(req.params.methodId);
  if (!method) throw new ApiError(404, 'Payout method not found');
  user.payoutMethods.forEach(m => { m.isDefault = false; });
  method.isDefault = true;
  await user.save();
  return ok(res, { payoutMethods: user.payoutMethods });
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
  deactivateMe,
  deleteMe,
  search,
  getPublicProfile,
  adminGetAll,
  adminGetOne,
  adminCreate,
  adminUpdate,
  adminDelete,
  adminChangePassword,
  deactivate,
  reactivate,
  revokeRole,
  grantRole,
  addPayoutMethod,
  removePayoutMethod,
  setDefaultPayoutMethod,
};
