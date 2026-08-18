const { z } = require('zod');

const updateProfile = z.object({
  fullName: z.string().min(1).optional(),
  preferredLanguage: z.enum(['en', 'fr']).optional(),
  avatarUrl: z.string().url().optional(),
  // Set to true exactly once, by ProfileSetupScreen's final "Complete setup"
  // call — the flag that lets a returning user skip role selection entirely.
  onboardingCompleted: z.boolean().optional(),
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

module.exports = { updateProfile, addRole, adminGrantRole, linkAuthProvider };
