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
  // Every account whose frontend `role` is legitimately null — an
  // admin-only account, or a quincaillerie-only one before/without
  // approval (see Onboarding.tsx's RoleScreen) — resolves here instead of
  // colliding with a real role's demo identity. context.tsx passes this
  // exact key via `role ?? 'null-role'`. roleType is null on purpose: this
  // identity starts with no primary role at all (only the verifier/admin
  // convenience roles below), so registering as quincaillerie through it
  // still exercises the real pending→approve pipeline instead of the role
  // being pre-seeded for free.
  'null-role': { fullName: 'Demo Account (No Primary Role)', email: 'demo-null-role@mboatrust.test', roleType: null },
};

const getOrCreateDemoUser = catchAsync(async (req, res) => {
  if (!env.devAuthBypass) throw ApiError.notFound();
  const role = String(req.query.role || '');
  const template = DEMO_USERS[role];
  if (!template) throw ApiError.badRequest(`Unknown demo role "${role}"`);

  // The sidebar exposes Verifier/Admin panels from any logged-in role (see
  // WORKSPACE_LINKS) as a demo convenience — so every dev user also gets
  // 'verifier' and 'admin' roles, matching that UX, rather than needing a
  // separate identity-switch just to exercise those screens. Filtered for
  // Boolean since the 'null-role' template's roleType is deliberately null.
  const wantedRoles = [...new Set([template.roleType, 'verifier', 'admin'].filter(Boolean))];

  // Keyed by firebaseUid, not email — `dev-${role}` is the actual stable,
  // deterministic identity this function relies on (and the field the
  // unique index is really enforcing). Looking up by email instead used to
  // 409 with "Duplicate value for: firebaseUid" for any role whose DB
  // record predates a DEMO_USERS email-string change (e.g. the contractor
  // entry here was once `contractor@mboatrust.test`, no "demo-" prefix) —
  // the email lookup found nothing, so create() ran anyway and collided
  // with the real unique key on the pre-existing row.
  let user = await User.findOne({ firebaseUid: `dev-${role}` });
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
