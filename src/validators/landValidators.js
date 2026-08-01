const { z } = require('zod');
const { geoPoint } = require('./common');

const createLandListing = z.object({
  title: z.string().optional().default(''),
  region: z.string().optional().default(''),
  city: z.string().optional().default(''),
  titleType: z.string().optional().default(''),
  description: z.string().optional().default(''),
  imageUrl: z.string().optional().default(''),
  sizeSqm: z.number().positive(),
  price: z.number().min(0),
  location: geoPoint.optional(),
  documents: z
    .array(z.object({ type: z.string().min(1), fileUrl: z.string().url() }))
    .optional()
    .default([]),
});

const updateLandListing = createLandListing.partial().extend({
  disputeFlag: z.boolean().optional(),
});

const updateVerificationStatus = z.object({
  verificationStatus: z.enum(['unverified', 'pending', 'verified', 'flagged']),
  disputeReason: z.string().optional(),
});

const purchaseListing = z.object({
  amount: z.number().positive(),
});

module.exports = { createLandListing, updateLandListing, updateVerificationStatus, purchaseListing };
