// Note: bid comparison (score-ranked bids for a project) already exists at
// GET /projects/:projectId/bids-with-scores (matchingController.js, added
// by the fraud/matching guide) — not duplicated here as a second
// /bids/compare route, since that would just be the same feature twice.
const { Bid, Project, Contract, User, Escrow, TeamMember } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const notificationService = require('../services/notificationService');
const contractDocumentService = require('../services/contractDocumentService');

function isAdmin(user) {
  return user.roles?.some((r) => r.roleType === 'admin');
}

/** Contractor ids of every contractor `req.user` is an active
 * 'submit_milestones' team delegate for (see TeamMember.js) — empty for
 * everyone who isn't delegated to submit milestones on someone else's
 * behalf. Shared by scopeToParty's security scope and getAll's own
 * contractorId query-param handling below, so both agree on who counts as
 * "acting as" a given contractor. */
async function myDelegatedForIds(userId) {
  const rows = await TeamMember.find({ userId, status: 'active', permissions: 'submit_milestones' }).select('ownerId').lean();
  return rows.map((r) => r.ownerId);
}

/** A bid is private between the contractor who placed it and the funder who
 * owns the tender it's on — the raw Bid collection has no ownership check
 * of its own the way GET /projects/:id/bids-with-scores does, so without
 * this any authenticated caller could pull any contractor's price/timeline/
 * notes on any tender by projectId, or another contractor's bids by
 * contractorId. $and'd with whatever filter the client actually asked for,
 * so every existing legitimate query shape (mine as contractor, or on a
 * tender I own) keeps working unchanged. `delegatedForIds` widens "mine" to
 * also cover any contractor this caller is an active milestone delegate
 * for, so a delegate's own MyBidsScreen/ContractDetailScreen query (which
 * always sends `contractorId: user._id`) can surface the delegated
 * contractor's bids too — see getAll below. */
async function scopeToParty(req, clientFilter, delegatedForIds = []) {
  if (isAdmin(req.user)) return clientFilter;
  const myProjects = await Project.find({ ownerId: req.user._id }).select('_id').lean();
  const partyOr = {
    $or: [
      { contractorId: { $in: [req.user._id, ...delegatedForIds] } },
      { projectId: { $in: myProjects.map((p) => p._id) } },
    ],
  };
  return Object.keys(clientFilter).length > 0 ? { $and: [clientFilter, partyOr] } : partyOr;
}

const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, projectId, contractorId, status } = req.query;
  const clientFilter = {};
  if (projectId) clientFilter.projectId = projectId;
  let delegatedForIds = [];
  if (contractorId) {
    // Only expand when the caller is asking for their OWN contractorId
    // (the shape every real screen sends) — an admin or funder filtering by
    // some other contractor's id gets exactly that contractor, unexpanded.
    if (String(contractorId) === String(req.user._id)) {
      delegatedForIds = await myDelegatedForIds(req.user._id);
      clientFilter.contractorId = delegatedForIds.length > 0 ? { $in: [contractorId, ...delegatedForIds] } : contractorId;
    } else {
      clientFilter.contractorId = contractorId;
    }
  }
  if (status) clientFilter.status = status;
  const filter = await scopeToParty(req, clientFilter, delegatedForIds);

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
  if (!isAdmin(req.user)) {
    const project = await Project.findById(bid.projectId).select('ownerId').lean();
    const isOwner = project && String(project.ownerId) === String(req.user._id);
    const isBidder = String(bid.contractorId) === String(req.user._id);
    if (!isOwner && !isBidder) throw ApiError.forbidden('Not your bid to view');
  }
  return ok(res, bid);
});

const create = catchAsync(async (req, res) => {
  const project = await Project.findById(req.body.projectId);
  if (!project || project.projectType !== 'tender') throw ApiError.notFound('Tender not found');
  if (project.status !== 'open') throw ApiError.conflict('This tender is no longer open for bids');
  if (String(project.ownerId) === String(req.user._id)) {
    throw ApiError.badRequest('You cannot bid on your own tender');
  }
  // One bid per contractor per tender, permanently — even a rejected or
  // withdrawn bid doesn't free up a second attempt, so this checks for any
  // prior bid regardless of status. The unique index on Bid (projectId +
  // contractorId) is the hard guarantee for two simultaneous submit clicks
  // racing past this check at the same instant; caught below as the
  // friendlier version of that same conflict.
  const existingBid = await Bid.findOne({ projectId: project._id, contractorId: req.user._id }).select('_id').lean();
  if (existingBid) throw ApiError.conflict('You have already submitted a bid on this tender');

  const { price, timelineDays, milestones = [], notes = '' } = req.body;
  let bid;
  try {
    bid = await Bid.create({
      ...req.body,
      contractorId: req.user._id,
      // The negotiation's opening round — every subsequent counter (either
      // side) appends here; the top-level price/timelineDays/milestones
      // fields above always mirror rounds[rounds.length - 1].
      rounds: [{ proposedBy: 'contractor', price, timelineDays, milestones, message: notes, createdAt: new Date() }],
      lastProposedBy: 'contractor',
    });
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('You have already submitted a bid on this tender');
    throw err;
  }
  await notificationService.notify(project.ownerId, 'bid_received', {
    projectId: project._id,
    bidId: bid._id,
  });
  return created(res, bid);
});

/** Either real party to this bid's negotiation — the tender owner or the
 * bidding contractor — appends a new round (price/timeline/schedule/
 * message) while the bid is still open. Unlike a strict alternating
 * protocol, either side may counter again even before the other has
 * responded — real negotiations aren't always strictly turn-based, and the
 * only thing that actually matters is who proposed the *current* live
 * terms (lastProposedBy), which is what accept/reject act on. */
const counter = catchAsync(async (req, res) => {
  const bid = await Bid.findById(req.params.id);
  if (!bid) throw ApiError.notFound('Bid not found');
  const project = await Project.findById(bid.projectId);
  if (!project) throw ApiError.notFound('Project not found');

  const isOwner = String(project.ownerId) === String(req.user._id);
  const isBidder = String(bid.contractorId) === String(req.user._id);
  if (!isOwner && !isBidder) throw ApiError.forbidden('Not a party to this negotiation');
  if (bid.status !== 'submitted') throw ApiError.conflict(`Cannot counter a bid that is already ${bid.status}`);

  const proposedBy = isOwner ? 'funder' : 'contractor';
  const { price, timelineDays, milestones = [], message = '' } = req.body;
  bid.rounds.push({ proposedBy, price, timelineDays, milestones, message, createdAt: new Date() });
  bid.price = price;
  bid.timelineDays = timelineDays;
  bid.milestones = milestones;
  bid.lastProposedBy = proposedBy;
  await bid.save();

  const notifyTarget = proposedBy === 'funder' ? bid.contractorId : project.ownerId;
  await notificationService.notify(notifyTarget, 'bid_countered', { projectId: project._id, bidId: bid._id });

  return ok(res, bid);
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

  // The negotiation's final terms get locked onto the project the moment
  // it's accepted — this is the actual "mutually accepted agreement"
  // moment the whole negotiation was building toward. Only blocked once
  // real money has already moved against the *original* numbers: changing
  // the total after funding would desync the escrow ledger, and fixing
  // that for real needs a refund/top-up flow this doesn't have.
  const changesTerms = status === 'accepted' && (bid.price !== project.totalAmount || bid.milestones.length > 0);
  if (changesTerms) {
    const alreadyFunded = await Escrow.findOne({ projectId: project._id, type: 'fund', status: 'completed' }).select('_id').lean();
    if (alreadyFunded) {
      throw ApiError.conflict('This project has already received funding at its original terms — accepting different terms now would desync escrow. Reject or renegotiate before any funds are collected.');
    }
  }

  bid.status = status;
  await bid.save();

  let contract = null;
  if (status === 'accepted') {
    if (changesTerms) {
      project.totalAmount = bid.price;
      if (bid.milestones.length > 0) {
        project.milestones = bid.milestones.map((m, i) => ({ name: m.title, description: m.description, amount: m.amount, orderIndex: i }));
      } else if (project.milestones.length > 0) {
        // The accepted bid never proposed its own schedule (a lump-sum
        // counter-offer) — the existing milestones still sum to whatever
        // the *previous* totalAmount was, so leaving them as-is would let a
        // negotiated price change silently desync from what escrow actually
        // releases per milestone. Rescale each amount proportionally to the
        // new total instead, keeping the same names/weights; the last
        // milestone absorbs the rounding remainder so the sum is exact.
        const oldTotal = project.milestones.reduce((sum, m) => sum + m.amount, 0);
        let allocated = 0;
        project.milestones.forEach((m, i) => {
          if (i === project.milestones.length - 1) {
            m.amount = bid.price - allocated;
          } else {
            const share = oldTotal > 0 ? Math.round((m.amount / oldTotal) * bid.price) : Math.round(bid.price / project.milestones.length);
            m.amount = share;
            allocated += share;
          }
        });
      }
    }
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

/**
 * How many live bids a tender has — a single integer, never any bid
 * contents. Deliberately NOT run through scopeToParty the way getAll is:
 * that scope exists because getAll returns the bids themselves, and it has
 * the side effect that a contractor browsing someone else's tender always
 * saw a count of 0 (they're party to none of those bids), which is exactly
 * the competition signal the browse screen is meant to show. An aggregate
 * count leaks nothing about who bid or for how much, so it's safe for any
 * signed-in user to read.
 *
 * Counts only bids still standing — 'withdrawn' and 'rejected' bids aren't
 * competition any more, so including them would overstate the field.
 */
const getCountForProject = catchAsync(async (req, res) => {
  const { projectId } = req.query;
  if (!projectId) throw ApiError.badRequest('projectId is required');
  const count = await Bid.countDocuments({ projectId, status: { $in: ['submitted', 'accepted'] } });
  return ok(res, { count });
});

module.exports = { getAll, getOne, create, counter, updateStatus, getCountForProject };
