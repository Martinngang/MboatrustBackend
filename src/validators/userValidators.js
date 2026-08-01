const { z } = require('zod');

const updateProfile = z.object({
  fullName: z.string().min(1).optional(),
  preferredLanguage: z.enum(['en', 'fr']).optional(),
  avatarUrl: z.string().url().optional(),
});

const addRole = z.object({
  roleType: z.enum(['funder', 'recipient', 'contractor', 'land_seller', 'verifier', 'admin']),
});

const linkAuthProvider = z.object({
  provider: z.enum(['google', 'email', 'phone']),
  providerId: z.string().min(1),
});

module.exports = { updateProfile, addRole, linkAuthProvider };
