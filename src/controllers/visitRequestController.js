const { VisitRequest, LandListing } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const notificationService = require('../services/notificationService');

const request = catchAsync(async (req, res) => {
  const listing = await LandListing.findById(req.body.listingId);
  if (!listing) throw ApiError.notFound('Land listing not found');

  const visit = await VisitRequest.create({
    listingId: listing._id,
    requestedBy: req.user._id,
    proposedDates: req.body.proposedDates,
    notes: req.body.notes || '',
  });
  await notificationService.notify(listing.sellerId, 'visit_requested', {
    listingId: listing._id,
    visitId: visit._id,
  });
  return created(res, visit);
});

/** Seller only — picks one of the buyer's proposed dates (or a different one entirely). */
const confirm = catchAsync(async (req, res) => {
  const visit = await VisitRequest.findById(req.params.id);
  if (!visit) throw ApiError.notFound('Visit request not found');
  if (visit.status !== 'requested') throw ApiError.conflict(`Visit is already "${visit.status}"`);

  const listing = await LandListing.findById(visit.listingId);
  if (!listing) throw ApiError.notFound('Land listing not found');
  if (String(listing.sellerId) !== String(req.user._id)) throw ApiError.forbidden('Only the seller can confirm a visit');

  visit.confirmedDate = req.body.confirmedDate;
  visit.status = 'confirmed';
  await visit.save();
  await notificationService.notify(visit.requestedBy, 'visit_confirmed', {
    visitId: visit._id,
    confirmedDate: visit.confirmedDate,
  });
  return ok(res, visit);
});

const complete = catchAsync(async (req, res) => {
  const visit = await VisitRequest.findById(req.params.id);
  if (!visit) throw ApiError.notFound('Visit request not found');
  if (visit.status !== 'confirmed') throw ApiError.conflict('Only a confirmed visit can be marked completed');

  const listing = await LandListing.findById(visit.listingId);
  if (!listing) throw ApiError.notFound('Land listing not found');
  const isSeller = String(listing.sellerId) === String(req.user._id);
  const isBuyer = String(visit.requestedBy) === String(req.user._id);
  if (!isSeller && !isBuyer) throw ApiError.forbidden();

  visit.status = 'completed';
  await visit.save();
  return ok(res, visit);
});

/** Buyer can cancel their own request at any time before completion; the
 * seller can also cancel (e.g. listing pulled) — either party, unlike
 * confirm/complete which are role-specific. */
const cancel = catchAsync(async (req, res) => {
  const visit = await VisitRequest.findById(req.params.id);
  if (!visit) throw ApiError.notFound('Visit request not found');
  if (visit.status === 'completed') throw ApiError.conflict('Cannot cancel a completed visit');

  const listing = await LandListing.findById(visit.listingId);
  const isSeller = listing && String(listing.sellerId) === String(req.user._id);
  const isBuyer = String(visit.requestedBy) === String(req.user._id);
  if (!isSeller && !isBuyer) throw ApiError.forbidden();

  visit.status = 'cancelled';
  await visit.save();
  return ok(res, visit);
});

/** A visit request's dates/notes are private between the buyer who asked
 * and the listing's seller — every other filtered `getAll` in this codebase
 * defaults an unfiltered call to "mine" rather than the platform-wide list
 * (see land-offers, escrows, contracts); this one had no scoping at all. */
const getAll = catchAsync(async (req, res) => {
  const { listingId, requestedBy, status } = req.query;
  const filter = {};
  if (status) filter.status = status;

  if (listingId) {
    const listing = await LandListing.findById(listingId).select('sellerId').lean();
    const isSeller = listing && String(listing.sellerId) === String(req.user._id);
    filter.listingId = listingId;
    if (!isSeller) filter.requestedBy = req.user._id;
  } else if (requestedBy) {
    if (String(requestedBy) !== String(req.user._id)) throw ApiError.forbidden("Cannot view another user's visit requests");
    filter.requestedBy = requestedBy;
  } else {
    const myListings = await LandListing.find({ sellerId: req.user._id }).select('_id').lean();
    filter.$or = [{ requestedBy: req.user._id }, { listingId: { $in: myListings.map((l) => l._id) } }];
  }

  const items = await VisitRequest.find(filter).populate('requestedBy', 'fullName').sort('-createdAt');
  return ok(res, items);
});

module.exports = { request, confirm, complete, cancel, getAll };
