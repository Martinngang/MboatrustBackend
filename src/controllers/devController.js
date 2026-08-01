const { User } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const env = require('../config/env');

/**
 * Dev-only bridge between the frontend's existing mock onboarding (phone/OTP,
 * role picker — none of it backed by real Firebase auth yet) and the real
 * backend. Firebase Sign-In has not been wired into the frontend (that is
 * still a separate, not-yet-done piece of Phase 2); until it is, this
 * find-or-creates one fixed demo User per role so the DEV_AUTH_BYPASS
 * header (`x-dev-user-id`) has a real Mongo _id to point at, letting real
 * API calls work end-to-end today. Only mounted/active when
 * DEV_AUTH_BYPASS=true — never available in production.
 */
// Keyed by the frontend's Role string (funder/recipient/contractor/seller) —
// `roleType` is the corresponding value from User's roleType enum, which
// isn't always the same string (the frontend's "seller" is "land_seller"
// on the backend).
const DEMO_USERS = {
  funder: { fullName: 'Demo Funder', email: 'demo-funder@mboatrust.test', roleType: 'funder' },
  recipient: { fullName: 'Demo Recipient', email: 'demo-recipient@mboatrust.test', roleType: 'recipient' },
  contractor: { fullName: 'Demo Contractor', email: 'demo-contractor@mboatrust.test', roleType: 'contractor' },
  seller: { fullName: 'Demo Seller', email: 'demo-seller@mboatrust.test', roleType: 'land_seller' },
};

const getOrCreateDemoUser = catchAsync(async (req, res) => {
  if (!env.devAuthBypass) throw ApiError.notFound();
  const role = String(req.query.role || '');
  const template = DEMO_USERS[role];
  if (!template) throw ApiError.badRequest(`Unknown demo role "${role}"`);

  // The sidebar exposes Verifier/Admin panels from any logged-in role (see
  // WORKSPACE_LINKS) as a demo convenience — so every dev user also gets
  // 'verifier' and 'admin' roles, matching that UX, rather than needing a
  // separate identity-switch just to exercise those screens.
  const wantedRoles = [...new Set([template.roleType, 'verifier', 'admin'])];

  let user = await User.findOne({ email: template.email });
  if (!user) {
    user = await User.create({
      fullName: template.fullName,
      email: template.email,
      firebaseUid: `dev-${role}`,
      authProviders: [{ provider: 'email', providerId: `dev-${role}` }],
      roles: wantedRoles.map((roleType) => ({ roleType })),
    });
  } else {
    const missing = wantedRoles.filter((rt) => !user.roles.some((r) => r.roleType === rt));
    if (missing.length > 0) {
      user.roles.push(...missing.map((roleType) => ({ roleType })));
      await user.save();
    }
  }

  return ok(res, { userId: user._id });
});

module.exports = { getOrCreateDemoUser };
