const { z } = require('zod');
const { geoPoint, requiredGeoPoint, locationDetailsExtras } = require('./common');

const milestoneInput = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(''),
  amount: z.number().min(0),
  orderIndex: z.number().int().min(0),
  requiresVideo: z.boolean().optional().default(false),
  requiresVerifier: z.boolean().optional().default(false),
  requiresCosigner: z.boolean().optional().default(false),
  // Optional — where THIS milestone happens, distinct from the project's
  // own `location`. See Project.js's MilestoneSchema comment.
  location: geoPoint.optional(),
});

const createProject = z.object({
  projectType: z.enum(['funding', 'tender', 'land_purchase']),
  title: z.string().min(1),
  description: z.string().optional().default(''),
  category: z.string().optional().default(''),
  locationName: z.string().optional().default(''),
  location: geoPoint.optional(),
  ...locationDetailsExtras,
  // Not `.url()` — combined with `.default('')` that fails Zod's own
  // default value (the empty string isn't a valid URL either), rejecting
  // every request that omits imageUrl entirely.
  imageUrl: z.string().optional().default(''),
  deadline: z.coerce.date().optional(),
  totalAmount: z.number().min(0),
  currency: z.enum(['USD', 'EUR', 'GBP', 'XAF']).optional().default('XAF'),
  requiresMultiSig: z.boolean().optional().default(false),
  milestones: z.array(milestoneInput).optional().default([]),
  // The funder's yes/no answer to "do you already have a project plan?" —
  // the file itself (if yes) is a follow-up multipart call to
  // POST /projects/:id/plan-document, since this endpoint is plain JSON.
  hasExistingPlan: z.boolean().optional().default(false),
  // Supplier requirement chosen at posting time. have_supplier needs a real
  // supplier id; need_supplier / none never carry one.
  supplierRequirement: z.enum(['none', 'have_supplier', 'need_supplier']).optional().default('none'),
  preferredSupplierId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id').nullable().optional(),
  // Materials-managed-by is deliberately NOT set here — a project always
  // starts 'contractor'-managed (the Project schema default) and only ever
  // becomes supplier-managed via POST /projects/:id/assign-supplier, once
  // the funder has actually browsed/compared real stores. Forcing a store
  // pick into the creation form (an earlier version of this) skipped that
  // comparison step entirely.
});

const updateProject = z.object({
  projectType: z.enum(['funding', 'tender', 'land_purchase']).optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  locationName: z.string().optional(),
  location: geoPoint.optional(),
  ...locationDetailsExtras,
  imageUrl: z.string().optional(),
  deadline: z.coerce.date().optional(),
  totalAmount: z.number().min(0).optional(),
  currency: z.enum(['USD', 'EUR', 'GBP', 'XAF']).optional(),
  requiresMultiSig: z.boolean().optional(),
  milestones: z.array(milestoneInput).optional(),
});

// Dedicated endpoint rather than folded into updateProject — assigning a
// supplier is pure routing metadata (unlike totalAmount/milestones, it can
// never desync an escrow ledger), so it must stay legal at any project
// status, not just while still 'draft'/'open' like the generic update.
// `supplierId: null` unassigns, reverting to 'contractor'-managed.
const assignSupplier = z.object({
  supplierId: z.string().nullable().optional(),
  // With no supplierId: 'need_supplier' marks the tender as still needing
  // one sourced, 'none' (default) clears the requirement entirely.
  supplierRequirement: z.enum(['none', 'need_supplier']).optional(),
});

const fundProject = z.object({
  amount: z.number().positive(),
  paymentProvider: z.enum(['mtn_momo', 'orange_money', 'flutterwave', 'stripe']),
  currency: z.enum(['USD', 'EUR', 'GBP', 'XAF']).optional().default('XAF'),
  payerPhoneNumber: z.string().min(6).optional(),
});

const submitEvidence = z.object({
  type: z.enum(['photo', 'video']),
  fileUrl: z.string().url().optional(),
  notes: z.string().max(2000).optional(),
  // Flat fields, not a nested `geotag` object, because this comes in as
  // multipart/form-data alongside the file (FormData can't nest objects) —
  // a device-sourced fallback for when the uploaded file's own EXIF has no
  // GPS tag (common for browser file-input uploads, which often strip it).
  geotagLat: z.coerce.number().min(-90).max(90).optional(),
  geotagLng: z.coerce.number().min(-180).max(180).optional(),
  // Already resolved client-side the moment the GPS fix came in (see
  // MilestoneSubmitScreen's useReverseGeocodeQuery) — without this in the
  // schema, the validator silently stripped it from req.body before the
  // controller ever saw it, so every submission fell through to the
  // server-side re-geocode fallback regardless of what the client sent.
  placeName: z.string().max(500).optional(),
  formattedAddress: z.string().max(1000).optional(),
  fileHash: z.string().optional(),
  // How the file was obtained — 'ar_camera' for a live in-app HUD-camera
  // capture, 'gallery_upload' (default) for anything picked from an
  // existing file/gallery. See Project.js's EvidenceSchema.captureSource.
  captureSource: z.enum(['ar_camera', 'gallery_upload']).optional().default('gallery_upload'),
});

const decideApproval = z.object({
  status: z.enum(['approved', 'rejected']),
});

const requestChanges = z.object({
  reason: z.string().min(1),
});

// Dedicated endpoint, same reasoning as assignSupplier above — a pin
// correction is metadata, never money, so it must stay legal at any project
// status, not just while still 'draft'/'open' like the generic update.
const updateLocation = z.object({
  location: requiredGeoPoint,
  ...locationDetailsExtras,
});

const requestLocationVerification = z.object({
  verifierId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id'),
});

module.exports = {
  createProject,
  updateProject,
  assignSupplier,
  fundProject,
  submitEvidence,
  decideApproval,
  requestChanges,
  updateLocation,
  requestLocationVerification,
};
