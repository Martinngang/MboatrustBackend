const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const { initFirebase } = require('../config/firebase');
const { devAuthBypass } = require('../config/env');
const { User } = require('../models');

// Firebase's decoded token exposes every provider currently linked to this
// UID under `firebase.identities` (e.g. { 'google.com': ['sub'], email:
// ['a@b.com'], phone: ['+237...'] }) — this is the ground truth for account
// linking, since `linkWithCredential`/`linkWithPopup` on the client add a
// new entry here without changing the UID. `sign_in_provider` alone only
// reflects the method used for *this* token, not everything linked.
const IDENTITY_KEY_TO_PROVIDER = { 'google.com': 'google', email: 'email', phone: 'phone' };

function parseAuthProviders(decoded) {
  const identities = decoded.firebase?.identities || {};
  const providers = [];
  for (const [key, values] of Object.entries(identities)) {
    const provider = IDENTITY_KEY_TO_PROVIDER[key];
    if (!provider || !Array.isArray(values) || values.length === 0) continue;
    providers.push({ provider, providerId: String(values[0]) });
  }
  // Fallback for tokens without a populated `identities` claim.
  if (providers.length === 0) {
    const provider = decoded.firebase?.sign_in_provider?.includes('phone')
      ? 'phone'
      : decoded.firebase?.sign_in_provider?.includes('google')
      ? 'google'
      : 'email';
    providers.push({ provider, providerId: decoded.uid });
  }
  return providers;
}

/**
 * Core identity resolution shared by the HTTP `authenticate` middleware and
 * the Socket.IO connection handler (see server.js) — verifies a Firebase ID
 * token, or (dev-only) trusts an `x-dev-user-id`-style value directly, and
 * returns the corresponding local User document, JIT-provisioning one on
 * first sign-in. Returns `null` for any failure instead of throwing, so
 * callers can decide how to react (HTTP 401 vs. dropping a socket).
 */
async function resolveUser({ authHeader, devUserId }) {
  if (!authHeader && devAuthBypass) {
    if (!devUserId) return null;
    return User.findById(devUserId).catch(() => null);
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const admin = initFirebase();
  if (!admin) return null;

  const idToken = authHeader.slice('Bearer '.length);
  const decoded = await admin.auth().verifyIdToken(idToken).catch(() => null);
  if (!decoded) return null;

  const providers = parseAuthProviders(decoded);
  let user = await User.findOne({ firebaseUid: decoded.uid });
  if (!user) {
    user = await User.create({
      fullName: decoded.name || 'New User',
      email: decoded.email || undefined,
      phoneNumber: decoded.phone_number || undefined,
      firebaseUid: decoded.uid,
      authProviders: providers,
    });
  } else {
    // Keep the linked-provider list current — e.g. a user who signed up
    // with phone and later links Google in Settings keeps the same
    // firebaseUid, so this is the only place that picks the change up.
    const knownProviders = new Set(user.authProviders.map((p) => p.provider));
    const newlyLinked = providers.filter((p) => !knownProviders.has(p.provider));
    const emailChanged = decoded.email && user.email !== decoded.email;
    const phoneChanged = decoded.phone_number && user.phoneNumber !== decoded.phone_number;
    if (newlyLinked.length > 0 || emailChanged || phoneChanged) {
      user.authProviders.push(...newlyLinked);
      if (emailChanged) user.email = decoded.email;
      if (phoneChanged) user.phoneNumber = decoded.phone_number;
      await user.save();
    }
  }

  return user;
}

/**
 * Verifies the Firebase ID token sent as `Authorization: Bearer <token>`
 * and attaches the corresponding local User document as req.user,
 * creating one on first sign-in ("just-in-time" user provisioning").
 *
 * Dev-only escape hatch: when DEV_AUTH_BYPASS=true and no Authorization
 * header is present, a `x-dev-user-id` header is used directly as the
 * Mongo user _id. Never enable this in production.
 */
const authenticate = catchAsync(async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const devUserId = req.headers['x-dev-user-id'];

  if (!authHeader && devAuthBypass) {
    if (!devUserId) {
      throw ApiError.unauthorized('DEV_AUTH_BYPASS is on but x-dev-user-id header is missing');
    }
    const user = await resolveUser({ authHeader, devUserId });
    if (!user) throw ApiError.unauthorized('No such dev user');
    if (!user.isActive) throw ApiError.forbidden('This account has been deactivated');
    req.user = user;
    return next();
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Missing Authorization header');
  }

  if (!initFirebase()) {
    throw ApiError.unauthorized('Auth is not configured on this server');
  }

  const user = await resolveUser({ authHeader, devUserId });
  if (!user) throw ApiError.unauthorized('Invalid or expired token');
  // admin.deactivate() (see userController.js) previously only flipped this
  // flag for display — nothing ever checked it, so a deactivated account
  // could keep transacting normally as long as its Firebase token was
  // still valid.
  if (!user.isActive) throw ApiError.forbidden('This account has been deactivated');

  req.user = user;
  next();
});

/** Restricts a route to users who hold at least one of the given roleTypes. */
function requireRole(...roleTypes) {
  return (req, res, next) => {
    const hasRole = req.user?.roles?.some((r) => roleTypes.includes(r.roleType));
    if (!hasRole) return next(ApiError.forbidden(`Requires role: ${roleTypes.join(' or ')}`));
    next();
  };
}

module.exports = { authenticate, requireRole, resolveUser };
