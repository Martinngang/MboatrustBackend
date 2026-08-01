const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const { initFirebase } = require('../config/firebase');
const { devAuthBypass } = require('../config/env');
const { User } = require('../models');

/**
 * Verifies the Firebase ID token sent as `Authorization: Bearer <token>`
 * and attaches the corresponding local User document as req.user,
 * creating one on first sign-in ("just-in-time" user provisioning).
 *
 * Dev-only escape hatch: when DEV_AUTH_BYPASS=true and no Authorization
 * header is present, a `x-dev-user-id` header is used directly as the
 * Mongo user _id. Never enable this in production.
 */
const authenticate = catchAsync(async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader && devAuthBypass) {
    const devUserId = req.headers['x-dev-user-id'];
    if (!devUserId) {
      throw ApiError.unauthorized('DEV_AUTH_BYPASS is on but x-dev-user-id header is missing');
    }
    const user = await User.findById(devUserId);
    if (!user) throw ApiError.unauthorized('No such dev user');
    req.user = user;
    return next();
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Missing Authorization header');
  }

  const admin = initFirebase();
  if (!admin) {
    throw ApiError.unauthorized('Auth is not configured on this server');
  }

  const idToken = authHeader.slice('Bearer '.length);
  const decoded = await admin.auth().verifyIdToken(idToken).catch(() => {
    throw ApiError.unauthorized('Invalid or expired token');
  });

  let user = await User.findOne({ firebaseUid: decoded.uid });
  if (!user) {
    const provider = decoded.firebase?.sign_in_provider?.includes('phone')
      ? 'phone'
      : decoded.firebase?.sign_in_provider?.includes('google')
      ? 'google'
      : 'email';

    user = await User.create({
      fullName: decoded.name || 'New User',
      email: decoded.email || undefined,
      phoneNumber: decoded.phone_number || undefined,
      firebaseUid: decoded.uid,
      authProviders: [{ provider, providerId: decoded.uid }],
    });
  }

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

module.exports = { authenticate, requireRole };
