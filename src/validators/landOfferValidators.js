const { z } = require('zod');

const createOffer = z.object({
  listingId: z.string().min(1),
  offerAmount: z.number().positive(),
  message: z.string().optional(),
});

const counterOffer = z.object({
  counterAmount: z.number().positive(),
});

module.exports = { createOffer, counterOffer };
