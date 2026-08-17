const { Conversation, Project, Bid, LandListing } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

/** Verifies contextId refers to a real record and that this conversation
 * actually involves that record's real party (the project owner / bid's
 * two sides / listing's seller) — otherwise anyone could start a
 * conversation "about" a project or bid they have nothing to do with,
 * attributing it to a context that's unrelated or doesn't even exist. Not
 * gated to only the two direct parties, though: e.g. a prospective funder
 * asking a project's recipient a question before ever funding is a real,
 * intended flow — so the rule is "the real party must be involved
 * somehow," not "you must already have a relationship to it." */
async function assertLegitimateContext(contextType, contextId, callerId, participantIds) {
  const notFound = () => ApiError.notFound(`${contextType === 'land_listing' ? 'Listing' : contextType[0].toUpperCase() + contextType.slice(1)} not found`);
  const forbidden = () => ApiError.forbidden('Not authorized to start this conversation');

  if (contextType === 'project') {
    const project = await Project.findById(contextId).select('ownerId');
    if (!project) throw notFound();
    const ownerId = String(project.ownerId);
    if (callerId !== ownerId && !participantIds.includes(ownerId)) throw forbidden();
  } else if (contextType === 'bid') {
    const bid = await Bid.findById(contextId).select('contractorId projectId').populate('projectId', 'ownerId');
    if (!bid) throw notFound();
    const contractorId = String(bid.contractorId);
    const ownerId = String(bid.projectId.ownerId);
    const isParty = callerId === contractorId || callerId === ownerId;
    if (!isParty) throw forbidden();
    // The other side of this specific bid must be who's being messaged.
    const expectedOther = callerId === contractorId ? ownerId : contractorId;
    if (!participantIds.includes(expectedOther)) throw forbidden();
  } else if (contextType === 'land_listing') {
    const listing = await LandListing.findById(contextId).select('sellerId');
    if (!listing) throw notFound();
    const sellerId = String(listing.sellerId);
    if (callerId !== sellerId && !participantIds.includes(sellerId)) throw forbidden();
  }
}

const getMine = catchAsync(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const filter = { participantIds: req.user._id };

  const [items, total] = await Promise.all([
    Conversation.find(filter)
      .populate('participantIds', 'fullName')
      .sort('-updatedAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    Conversation.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getOne = catchAsync(async (req, res) => {
  const conversation = await Conversation.findById(req.params.id).populate('participantIds', 'fullName');
  if (!conversation) throw ApiError.notFound('Conversation not found');
  if (!conversation.participantIds.some((p) => String(p._id) === String(req.user._id))) {
    throw ApiError.forbidden();
  }
  return ok(res, conversation);
});

/** Find-or-create — repeat "message this seller/contractor" clicks for the
 * same context reuse the existing thread instead of spawning duplicates. */
const create = catchAsync(async (req, res) => {
  const rawIds = Array.isArray(req.body.participantIds) ? req.body.participantIds : [];
  const participantIds = Array.from(new Set([...rawIds.filter(Boolean).map(String), String(req.user._id)])).sort();
  // Guards against silently persisting a single-participant conversation —
  // Mongoose casts an array of ObjectId refs by dropping any entry that
  // isn't a valid id (undefined, empty string, garbage), so an unfiltered
  // falsy otherUserId would otherwise pass validation and create a
  // conversation with only the caller in it, unreachable by anyone else.
  if (participantIds.length < 2) throw ApiError.badRequest('A conversation needs another real participant');

  await assertLegitimateContext(req.body.contextType, req.body.contextId, String(req.user._id), participantIds);

  const existing = await Conversation.findOne({
    contextType: req.body.contextType,
    contextId: req.body.contextId,
    participantIds: { $all: participantIds, $size: participantIds.length },
  }).populate('participantIds', 'fullName');
  if (existing) return ok(res, existing);

  const conversation = await Conversation.create({ ...req.body, participantIds });
  await conversation.populate('participantIds', 'fullName');
  return created(res, conversation);
});

module.exports = { getMine, getOne, create };
