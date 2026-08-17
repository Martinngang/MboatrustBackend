// Note: bid comparison (score-ranked bids for a project) already exists at
// GET /projects/:projectId/bids-with-scores (matchingController.js, added
// by the fraud/matching guide) — not duplicated here as a second
// /bids/compare route, since that would just be the same feature twice.
const { Bid, Project, Contract, User } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const notificationService = require('../services/notificationService');
const contractDocumentService = require('../services/contractDocumentService');

const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, projectId, contractorId, status } = req.query;
  const filter = {};
  if (projectId) filter.projectId = projectId;
  if (contractorId) filter.contractorId = contractorId;
  if (status) filter.status = status;

  const [items, total] = await Promise.all([
    Bid.find(filter)
      .populate('contractorId', 'fullName')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    Bid.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getOne = catchAsync(async (req, res) => {
  const bid = await Bid.findById(req.params.id);
  if (!bid) throw ApiError.notFound('Bid not found');
  return ok(res, bid);
});

const create = catchAsync(async (req, res) => {
  const project = await Project.findById(req.body.projectId);
  if (!project || project.projectType !== 'tender') throw ApiError.notFound('Tender not found');
  if (project.status !== 'open') throw ApiError.conflict('This tender is no longer open for bids');

  const bid = await Bid.create({ ...req.body, contractorId: req.user._id });
  await notificationService.notify(project.ownerId, 'bid_received', {
    projectId: project._id,
    bidId: bid._id,
  });
  return created(res, bid);
});

/** Contractor withdraws their own bid, or the tender owner accepts/rejects it. */
const updateStatus = catchAsync(async (req, res) => {
  const { status } = req.body;
  const bid = await Bid.findById(req.params.id);
  if (!bid) throw ApiError.notFound('Bid not found');

  const project = await Project.findById(bid.projectId);
  const isOwner = project && String(project.ownerId) === String(req.user._id);
  const isBidder = String(bid.contractorId) === String(req.user._id);

  if (status === 'withdrawn' && !isBidder) throw ApiError.forbidden('Only the bidder can withdraw a bid');
  if (['accepted', 'rejected'].includes(status) && !isOwner) {
    throw ApiError.forbidden('Only the tender owner can accept or reject bids');
  }
  if (bid.status !== 'submitted') throw ApiError.conflict(`Bid already ${bid.status}`);

  bid.status = status;
  await bid.save();

  let contract = null;
  if (status === 'accepted') {
    // Separate lookups rather than populating `bid`/`project` themselves —
    // those are reused above for the raw-ObjectId auth checks
    // (`String(bid.contractorId) === ...`), which a populated field would
    // silently break.
    const [contractor, owner] = await Promise.all([
      User.findById(bid.contractorId).select('fullName'),
      User.findById(project.ownerId).select('fullName'),
    ]);
    const { text: generatedDocumentText, url: generatedDocumentUrl } = await contractDocumentService.generateAndUploadContract({
      project,
      bid,
      contractorName: contractor?.fullName || String(bid.contractorId),
      ownerName: owner?.fullName || String(project.ownerId),
    });
    contract = await Contract.create({
      projectId: bid.projectId,
      bidId: bid._id,
      generatedDocumentText,
      generatedDocumentUrl,
    });
    project.status = 'in_progress';
    await project.save();
    await Bid.updateMany(
      { projectId: bid.projectId, _id: { $ne: bid._id }, status: 'submitted' },
      { status: 'rejected' }
    );
  }

  await notificationService.notify(bid.contractorId, 'bid_status_changed', {
    bidId: bid._id,
    status,
  });

  return ok(res, { bid, contract });
});

module.exports = { getAll, getOne, create, updateStatus };
