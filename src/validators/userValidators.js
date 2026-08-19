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
// legitimately grant any of them (including promoting another admin or
// approving a vetted verifier application).
const adminGrantRole = z.object({
  roleType: z.enum(['funder', 'recipient', 'contractor', 'land_seller', 'verifier', 'admin']),
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

module.exports = { updateProfile, addRole, adminGrantRole, linkAuthProvider, deleteMyAccount };
