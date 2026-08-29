const { z } = require('zod');
const { objectId } = require('./common');

const createRating = z.object({
  toUserId: objectId,
  projectId: objectId,
  score: z.number().int().min(1).max(5),
  comment: z.string().optional().default(''),
  roleContext: z.enum(['recipient', 'contractor', 'verifier', 'land_seller', 'quincaillerie']),
});

// Admin-authored rating (on behalf of a real user) — same shape as
// createRating, plus an explicit fromUserId since the admin isn't the
// author. Only reachable via the admin-gated route (see ratingRoutes.js).
const adminCreateRating = createRating.extend({
  fromUserId: objectId,
});

const adminUpdateRating = z.object({
  score: z.number().int().min(1).max(5).optional(),
  comment: z.string().optional(),
});

module.exports = { createRating, adminCreateRating, adminUpdateRating };
