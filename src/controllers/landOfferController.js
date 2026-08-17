const { LandOffer, LandListing } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const notificationService = require('../services/notificationService');
const { createPurchaseProject } = require('./landListingController');

const create = catchAsync(async (req, res) => {
  const listing = await LandListing.findById(req.body.listingId);
  if (!listing) throw ApiError.notFound('Land listing not found');
  if (listing.verificationStatus !== 'verified') throw ApiError.conflict('Only a verified listing can receive offers');
  if (listing.linkedProjectId) throw ApiError.conflict('This listing already has an active purchase in progress');
  if (String(listing.sellerId) === String(req.user._id)) throw ApiError.badRequest('Cannot make an offer on your own listing');

  const offer = await LandOffer.create({
    listingId: listing._id,
    buyerId: req.user._id,
    offerAmount: req.body.offerAmount,
    message: req.body.message || '',
  });
  await notificationService.notify(listing.sellerId, 'land_offer_received', {
    listingId: listing._id,
    offerId: offer._id,
    amount: offer.offerAmount,
  });
  return created(res, offer);
});

/** Seller only, and only while the offer is still at the buyer's original amount. */
const counter = catchAsync(async (req, res) => {
  const offer = await LandOffer.findById(req.params.id);
  if (!offer) throw ApiError.notFound('Offer not found');
  const listing = await LandListing.findById(offer.listingId);
  if (!listing) throw ApiError.notFound('Land listing not found');
  if (String(listing.sellerId) !== String(req.user._id)) throw ApiError.forbidden('Only the seller can counter an offer');
  if (offer.status !== 'pending') throw ApiError.conflict(`Offer is already "${offer.status}"`);

  offer.counterAmount = req.body.counterAmount;
  offer.status = 'countered';
  await offer.save();
  await notificationService.notify(offer.buyerId, 'land_offer_countered', {
    listingId: listing._id,
    offerId: offer._id,
    counterAmount: offer.counterAmount,
  });
  return ok(res, offer);
});

/** Seller accepts the buyer's original offer (status "pending"), or the
 * buyer accepts their own counter-offer (status "countered") — whichever
 * side didn't set the current price is the one who can accept it. Only here
 * does a real land_purchase Project get created, at whatever amount was
 * actually agreed. */
const accept = catchAsync(async (req, res) => {
  const offer = await LandOffer.findById(req.params.id);
  if (!offer) throw ApiError.notFound('Offer not found');
  const listing = await LandListing.findById(offer.listingId);
  if (!listing) throw ApiError.notFound('Land listing not found');

  const isSeller = String(listing.sellerId) === String(req.user._id);
  const isBuyer = String(offer.buyerId) === String(req.user._id);

  let agreedAmount;
  if (offer.status === 'pending') {
    if (!isSeller) throw ApiError.forbidden('Only the seller can accept the original offer');
    agreedAmount = offer.offerAmount;
  } else if (offer.status === 'countered') {
    if (!isBuyer) throw ApiError.forbidden('Only the buyer can accept the counter-offer');
    agreedAmount = offer.counterAmount;
  } else {
    throw ApiError.conflict(`Offer is already "${offer.status}"`);
  }

  const project = await createPurchaseProject(listing, offer.buyerId, agreedAmount);
  offer.status = 'accepted';
  await offer.save();
  return ok(res, { offer, listing, project });
});

const decline = catchAsync(async (req, res) => {
  const offer = await LandOffer.findById(req.params.id);
  if (!offer) throw ApiError.notFound('Offer not found');
  const listing = await LandListing.findById(offer.listingId);
  if (!listing) throw ApiError.notFound('Land listing not found');

  const isSeller = String(listing.sellerId) === String(req.user._id);
  const isBuyer = String(offer.buyerId) === String(req.user._id);
  if (offer.status === 'pending' && !isSeller) throw ApiError.forbidden('Only the seller can decline the original offer');
  if (offer.status === 'countered' && !isBuyer) throw ApiError.forbidden('Only the buyer can decline the counter-offer');
  if (!['pending', 'countered'].includes(offer.status)) throw ApiError.conflict(`Offer is already "${offer.status}"`);

  offer.status = 'declined';
  await offer.save();
  const notifyTarget = isSeller ? offer.buyerId : listing.sellerId;
  await notificationService.notify(notifyTarget, 'land_offer_declined', { listingId: listing._id, offerId: offer._id });
  return ok(res, offer);
});

const withdraw = catchAsync(async (req, res) => {
  const offer = await LandOffer.findById(req.params.id);
  if (!offer) throw ApiError.notFound('Offer not found');
  if (String(offer.buyerId) !== String(req.user._id)) throw ApiError.forbidden('Only the buyer can withdraw their own offer');
  if (!['pending', 'countered'].includes(offer.status)) throw ApiError.conflict(`Offer is already "${offer.status}"`);

  offer.status = 'withdrawn';
  await offer.save();
  return ok(res, offer);
});

/**
 * Every other filter is additive, but this must never let a caller see a
 * negotiation they aren't a party to — an offer's buyerId/offerAmount is
 * private between that buyer and the listing's seller, not public listing
 * data. Previously this had no scoping at all: any authenticated user could
 * fetch every LandOffer on the platform via an unfiltered GET.
 */
const getAll = catchAsync(async (req, res) => {
  const { listingId, buyerId, status } = req.query;
  const filter = {};
  if (status) filter.status = status;

  if (listingId) {
    const listing = await LandListing.findById(listingId).select('sellerId').lean();
    const isSeller = listing && String(listing.sellerId) === String(req.user._id);
    filter.listingId = listingId;
    // Not the seller of this listing? Only their own offers on it are visible.
    if (!isSeller) filter.buyerId = req.user._id;
  } else if (buyerId) {
    if (String(buyerId) !== String(req.user._id)) throw ApiError.forbidden("Cannot view another user's offers");
    filter.buyerId = buyerId;
  } else {
    // No explicit filter — default to everything the caller is actually a
    // party to: offers they made, or offers on listings they sell.
    const myListings = await LandListing.find({ sellerId: req.user._id }).select('_id').lean();
    filter.$or = [{ buyerId: req.user._id }, { listingId: { $in: myListings.map((l) => l._id) } }];
  }

  const items = await LandOffer.find(filter).populate('buyerId', 'fullName').sort('-createdAt');
  return ok(res, items);
});

module.exports = { create, counter, accept, decline, withdraw, getAll };
