const { LandListing, Project } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const storageService = require('../services/storageService');
const landDuplicateService = require('../services/landDuplicateService');
const notificationService = require('../services/notificationService');

const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, verificationStatus, sellerId, disputeFlag } = req.query;
  const filter = {};
  if (verificationStatus) filter.verificationStatus = verificationStatus;
  if (sellerId) filter.sellerId = sellerId;
  if (disputeFlag !== undefined) filter.disputeFlag = disputeFlag === 'true';

  const [items, total] = await Promise.all([
    LandListing.find(filter)
      .populate('sellerId', 'fullName')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    LandListing.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getOne = catchAsync(async (req, res) => {
  const listing = await LandListing.findById(req.params.id).populate('sellerId', 'fullName');
  if (!listing) throw ApiError.notFound('Land listing not found');
  return ok(res, listing);
});

const create = catchAsync(async (req, res) => {
  const listing = await LandListing.create({ ...req.body, sellerId: req.user._id });
  const duplicateId = await landDuplicateService.findDuplicate(listing);
  if (duplicateId) {
    listing.duplicateOfListingId = duplicateId;
    listing.disputeFlag = true;
    listing.disputeReason = 'Automatically flagged — matches the location and size of an existing listing';
    await listing.save();
  }
  await listing.populate('sellerId', 'fullName');
  return created(res, listing);
});

const update = catchAsync(async (req, res) => {
  const listing = await LandListing.findById(req.params.id);
  if (!listing) throw ApiError.notFound('Land listing not found');
  if (String(listing.sellerId) !== String(req.user._id)) throw ApiError.forbidden();
  Object.assign(listing, req.body);
  await listing.save();
  return ok(res, listing);
});

const remove = catchAsync(async (req, res) => {
  const listing = await LandListing.findById(req.params.id);
  if (!listing) throw ApiError.notFound('Land listing not found');
  if (String(listing.sellerId) !== String(req.user._id)) throw ApiError.forbidden();
  await listing.deleteOne();
  return res.status(204).send();
});

/** Seller uploads a supporting document (title deed, survey plan, etc.) for verification. */
const addDocument = catchAsync(async (req, res) => {
  const listing = await LandListing.findById(req.params.id);
  if (!listing) throw ApiError.notFound('Land listing not found');
  if (String(listing.sellerId) !== String(req.user._id)) throw ApiError.forbidden();
  if (!req.file) throw ApiError.badRequest('No file uploaded');

  const uploadResult = await storageService.uploadBuffer(req.file.buffer, {
    folder: `mboatrust/land-documents/${listing._id}`,
  });

  listing.documents.push({
    type: req.body.type || 'other',
    fileUrl: uploadResult.secure_url,
    verificationStatus: 'pending',
  });
  listing.verificationStatus = 'pending';
  await listing.save();
  return created(res, listing);
});

/** Admin/verifier action — sets the overall listing verification status. */
const updateVerificationStatus = catchAsync(async (req, res) => {
  const listing = await LandListing.findById(req.params.id);
  if (!listing) throw ApiError.notFound('Land listing not found');
  listing.verificationStatus = req.body.verificationStatus;
  if (req.body.verificationStatus === 'flagged') {
    listing.disputeFlag = true;
    if (req.body.disputeReason) listing.disputeReason = req.body.disputeReason;
  }
  await listing.save();
  return ok(res, listing);
});

/**
 * Creates the land_purchase Project (the same Project/Milestone/Escrow
 * machinery the funding and tender pillars already use — a single "full
 * payment on transfer" milestone stands in for a formal offer/negotiation
 * step, which isn't part of the architecture doc's data model) and links it
 * back to the listing. Factored out of the `purchase` route handler so
 * landOfferController's `accept` can call into the exact same project-
 * creation logic once an offer is agreed, instead of duplicating it.
 */
async function createPurchaseProject(listing, buyerId, amount) {
  if (listing.verificationStatus !== 'verified') {
    throw ApiError.conflict('Only a verified listing can be purchased');
  }
  if (listing.linkedProjectId) throw ApiError.conflict('This listing already has an active purchase in progress');

  const project = await Project.create({
    projectType: 'land_purchase',
    ownerId: buyerId,
    title: listing.title || `Land purchase — ${listing.city}`,
    description: `Purchase of ${listing.sizeSqm}m² plot in ${listing.city}, ${listing.region}.`,
    locationName: `${listing.city}, ${listing.region}`,
    location: listing.location,
    totalAmount: amount,
    status: 'open',
    milestones: [{ name: 'Full payment on ownership transfer', amount, orderIndex: 0 }],
  });

  listing.linkedProjectId = project._id;
  await listing.save();

  await notificationService.notify(listing.sellerId, 'land_purchase_started', {
    listingId: listing._id,
    projectId: project._id,
  });

  return project;
}

/** Buyer starts a purchase directly on a verified listing at its asking
 * price, skipping any negotiation — the original, still-supported path for
 * a buyer who doesn't want to haggle. See landOfferController for the
 * offer/counter/accept negotiation flow, which calls createPurchaseProject
 * too once both sides agree on a price. */
const purchase = catchAsync(async (req, res) => {
  const listing = await LandListing.findById(req.params.id);
  if (!listing) throw ApiError.notFound('Land listing not found');
  const project = await createPurchaseProject(listing, req.user._id, req.body.amount);
  return created(res, { listing, project });
});

module.exports = { getAll, getOne, create, update, remove, addDocument, updateVerificationStatus, purchase, createPurchaseProject };
