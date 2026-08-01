const { z } = require('zod');
const { geoPoint } = require('./common');

const milestoneInput = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(''),
  amount: z.number().min(0),
  orderIndex: z.number().int().min(0),
  requiresVideo: z.boolean().optional().default(false),
  requiresVerifier: z.boolean().optional().default(false),
  requiresCosigner: z.boolean().optional().default(false),
});

const createProject = z.object({
  projectType: z.enum(['funding', 'tender', 'land_purchase']),
  title: z.string().min(1),
  description: z.string().optional().default(''),
  category: z.string().optional().default(''),
  locationName: z.string().optional().default(''),
  location: geoPoint.optional(),
  // Not `.url()` — combined with `.default('')` that fails Zod's own
  // default value (the empty string isn't a valid URL either), rejecting
  // every request that omits imageUrl entirely.
  imageUrl: z.string().optional().default(''),
  deadline: z.coerce.date().optional(),
  totalAmount: z.number().min(0),
  currency: z.string().optional().default('XAF'),
  requiresMultiSig: z.boolean().optional().default(false),
  milestones: z.array(milestoneInput).optional().default([]),
});

const updateProject = createProject.partial();

const fundProject = z.object({
  amount: z.number().positive(),
  paymentProvider: z.enum(['mtn_momo', 'orange_money']),
  payerPhoneNumber: z.string().min(6),
});

const submitEvidence = z.object({
  type: z.enum(['photo', 'video']),
  fileUrl: z.string().url().optional(),
  // Flat fields, not a nested `geotag` object, because this comes in as
  // multipart/form-data alongside the file (FormData can't nest objects) —
  // a device-sourced fallback for when the uploaded file's own EXIF has no
  // GPS tag (common for browser file-input uploads, which often strip it).
  geotagLat: z.coerce.number().min(-90).max(90).optional(),
  geotagLng: z.coerce.number().min(-180).max(180).optional(),
  fileHash: z.string().optional(),
});

const decideApproval = z.object({
  status: z.enum(['approved', 'rejected']),
});

module.exports = { createProject, updateProject, fundProject, submitEvidence, decideApproval };
