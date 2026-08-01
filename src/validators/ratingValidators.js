const { z } = require('zod');
const { objectId } = require('./common');

const createRating = z.object({
  toUserId: objectId,
  projectId: objectId,
  score: z.number().int().min(1).max(5),
  comment: z.string().optional().default(''),
  roleContext: z.enum(['recipient', 'contractor', 'verifier', 'land_seller']),
});

module.exports = { createRating };
