const { z } = require('zod');

const updateProfile = z.object({
  fullName: z.string().min(1).optional(),
  preferredLanguage: z.enum(['en', 'fr']).optional(),
  avatarUrl: z.string().url().optional(),
  // Set to true exactly once, by ProfileSetupScreen's final "Complete setup"
  // call — the flag that lets a returning user skip role selection entirely.
  onboardingCompleted: z.boolean().optional(),
  // ISO 3166-1 alpha-2 (e.g. "FR") — the frontend's SearchableSelect always
  // sends a real country-state-city isoCode, never free text.
  residenceCountry: z.string().regex(/^[A-Z]{2}$/).optional(),
  residenceCity: z.string().min(1).optional(),
});

// Self-service roles only — a user can freely switch into any of these
// during onboarding or later (see Onboarding.tsx's ROLE_TYPE map and
// AdditionalScreens.tsx's contractor self-add, the only two real callers).
// 'verifier'/'admin' are trust-elevating and must never be self-grantable —
// see adminGrantRole below for the admin-only path onto those two.
const addRole = z.object({
  roleType: z.enum(['funder', 'recipient', 'contractor', 'land_seller']),
});

// Admin-only counterpart to addRole — the full role set, since an admin may
// legitimately grant any of them (including promoting another admin,
// approving a vetted verifier application, or approving a quincaillerie
// registration — see quincaillerieProfileController.approve for the atomic
// review-approval path onto 'quincaillerie'; this endpoint is the manual
// admin-drawer path onto the same role).
const adminGrantRole = z.object({
  roleType: z.enum(['funder', 'recipient', 'contractor', 'land_seller', 'verifier', 'admin', 'quincaillerie']),
});

const linkAuthProvider = z.object({
  provider: z.enum(['google', 'email', 'phone']),
  providerId: z.string().min(1),
});

// A literal typed confirmation, not just a boolean flag — the same
// belt-and-suspenders safety this endpoint's frontend already requires
// (a checkbox is not enough on its own for something genuinely
// irreversible), enforced at the API layer too so the endpoint can't be
// triggered by an accidental/malformed request.
const deleteMyAccount = z.object({
  confirm: z.literal('DELETE'),
});

// Admin-created account — no firebaseUid yet (the real person links it on
// their first actual sign-in, see middleware/auth.js's resolveUser). roles
// accepts the full enum, same as adminGrantRole, since an admin creating an
// account may need it pre-seeded with a role (e.g. onboarding a verifier
// hired outside the self-signup flow).
const adminCreateUser = z.object({
  fullName: z.string().min(1),
  email: z.string().email().optional(),
  phoneNumber: z.string().min(1).optional(),
  roles: z.array(z.enum(['funder', 'recipient', 'contractor', 'land_seller', 'verifier', 'admin', 'quincaillerie'])).optional(),
});

// Deliberately excludes roles/passwordHash/firebaseUid/authProviders/
// isActive — roles go through grantRole/revokeRole, isActive through
// deactivate/reactivate, and the auth fields would sever/hijack Firebase
// identity linkage if raw-edited. This is a strict allowlist, never a raw
// passthrough onto a User document.
const adminUpdateUser = z.object({
  fullName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phoneNumber: z.string().min(1).optional(),
  kycStatus: z.enum(['unverified', 'pending', 'verified', 'rejected']).optional(),
  kycLevel: z.enum(['basic', 'enhanced']).optional(),
  preferredLanguage: z.enum(['en', 'fr']).optional(),
  residenceCountry: z.string().regex(/^[A-Z]{2}$/).optional(),
  residenceCity: z.string().min(1).optional(),
  avatarUrl: z.string().url().optional(),
});

// TEMPORARY — see userController.adminChangePassword's comment.
const adminChangePassword = z.object({
  // Firebase's own minimum for a password set via the Admin SDK.
  newPassword: z.string().min(6),
});

const addPayoutMethod = z.object({
  label: z.string().max(50).default(''),
  provider: z.enum(['mtn_momo', 'orange_money']),
  phoneNumber: z.string().min(9).max(15),
});

module.exports = { updateProfile, addRole, adminGrantRole, linkAuthProvider, deleteMyAccount, adminCreateUser, adminUpdateUser, adminChangePassword, addPayoutMethod };
