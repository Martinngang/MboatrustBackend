const mongoose = require('mongoose');
const {
  Project, Escrow, Bid, LandListing, LandOffer, MaterialOrder, VerificationTask, Rating,
  SupplierProfile, ContractorProfile, User, Dispute,
} = require('../models');
const contractorStatsService = require('./contractorStatsService');
const { getFundingState } = require('./milestoneFundingService');
const { delegatedForIds } = require('./delegationService');
const { withdrawableFilter } = require('./withdrawableService');

/**
 * Every number a role dashboard shows, computed server-side for exactly one
 * user (always `req.user` — never a client-supplied id), shared by web and
 * mobile so the two apps can't compute the same tile two different ways.
 *
 * Counts are real countDocuments/aggregations. The dashboards used to count
 * client-side over list endpoints that default to 20 rows per page, so any
 * user past 20 bids/tasks/listings saw a silently capped number — and web's
 * seller home counted the platform's 20 newest listings, not the seller's.
 *
 * Money is summed in XAF (every tile is rendered with the XAF formatter):
 * a non-XAF escrow is converted with the rate stored on it at payment time.
 */

const toId = (id) => new mongoose.Types.ObjectId(String(id));
const LIST_LIMIT = 10;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// The app's own meaning of "active" (both frontends' mapProjectStatus maps
// funded/in_progress → 'active'); 'open' is a posted tender nobody has paid
// into yet.
const ACTIVE_PROJECT_STATUSES = ['funded', 'in_progress'];
// Mirrors applyApprovalDecision: a milestone is decidable in either state.
const AWAITING_DECISION = ['submitted', 'under_review'];

const XAF_NET = {
  $cond: [
    { $eq: ['$currency', 'XAF'] },
    '$netAmount',
    { $multiply: ['$netAmount', { $ifNull: ['$currencyConversion.rate', 1] }] },
  ],
};

async function sumXafNet(match) {
  const [row] = await Escrow.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: XAF_NET } } }]);
  return Math.round((row?.total || 0) * 100) / 100;
}

async function ratingSummary(userId, roleContext) {
  const [row] = await Rating.aggregate([
    { $match: { toUserId: toId(userId), roleContext } },
    { $group: { _id: null, average: { $avg: '$score' }, count: { $sum: 1 } } },
  ]);
  return { average: row ? Math.round(row.average * 10) / 10 : null, count: row?.count || 0 };
}

async function countByStatus(Model, match) {
  const rows = await Model.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [r._id, r.count]));
}

// ── Funder ───────────────────────────────────────────────────────────────

/** Milestones waiting on THIS user's decision — the same authorization
 * projectController.applyApprovalDecision enforces: the project owner always
 * decides; on a co-signed milestone (requiresCosigner, or the whole project
 * requiresMultiSig) the co-signer decides too, and whichever of the two has
 * already approved is no longer waiting. Paying into escrow grants no
 * approval rights, so a pooled co-funder is never shown someone else's
 * review as their own. */
async function milestonesAwaitingDecision(userId) {
  const uid = String(userId);
  const projects = await Project.find({
    status: { $nin: ['draft', 'cancelled'] },
    'milestones.status': { $in: AWAITING_DECISION },
    $or: [{ ownerId: userId }, { coSignerId: userId }],
  })
    .select('title ownerId coSignerId requiresMultiSig milestones._id milestones.name milestones.amount milestones.status milestones.requiresCosigner milestones.approvers')
    .lean();

  const items = [];
  for (const p of projects) {
    const isOwner = String(p.ownerId) === uid;
    for (const m of p.milestones) {
      if (!AWAITING_DECISION.includes(m.status)) continue;
      const coSigned = p.requiresMultiSig || m.requiresCosigner;
      const isCoSigner = Boolean(coSigned && p.coSignerId && String(p.coSignerId) === uid);
      if (!isOwner && !isCoSigner) continue;
      const alreadyApproved = (m.approvers || []).some((a) => String(a.userId) === uid && a.status === 'approved');
      if (alreadyApproved) continue;
      items.push({
        projectId: String(p._id),
        projectTitle: p.title,
        milestoneId: String(m._id),
        milestoneTitle: m.name,
        amount: m.amount,
        status: m.status,
      });
    }
  }
  return items;
}

async function funder(user) {
  const uid = toId(user._id);
  // Only `completed` funds: pending/failed never moved money, and a
  // `reversed` fund was refunded back to this funder.
  const myFundMatch = { funderId: uid, type: 'fund', status: 'completed' };
  const fundedProjectIds = await Escrow.distinct('projectId', myFundMatch);
  // A funder is involved in a project by paying into it OR by owning it (a
  // funder posts the tender, then funds its escrow).
  const involvedActive = {
    $or: [{ _id: { $in: fundedProjectIds } }, { ownerId: uid }],
    status: { $in: ACTIVE_PROJECT_STATUSES },
  };

  const [totalFunded, activeCount, activeDocs, awaiting, newBrowsableProjectsThisWeek] = await Promise.all([
    // This funder's OWN contribution. The old tile summed each funded
    // project's platform-wide `raised`, so co-funded money was counted as
    // every co-funder's personally.
    sumXafNet(myFundMatch),
    Project.countDocuments(involvedActive),
    Project.find(involvedActive)
      .select('title locationName totalAmount status fundingMode milestones')
      .sort('-updatedAt')
      .limit(LIST_LIMIT)
      .lean(),
    milestonesAwaitingDecision(uid),
    // Same scope the "Browse community projects" screen lists (funding
    // projects), so the banner's number matches what the user will see.
    Project.countDocuments({
      projectType: 'funding',
      status: { $nin: ['draft', 'cancelled'] },
      createdAt: { $gte: new Date(Date.now() - WEEK_MS) },
    }),
  ]);

  const summaries = await Promise.all(activeDocs.map((p) => getFundingState(p)));
  const awaitingProjectIds = new Set(awaiting.map((a) => a.projectId));
  const activeProjects = activeDocs.map((p, i) => {
    const current = p.milestones.find((m) => m.status !== 'released') || p.milestones[p.milestones.length - 1] || null;
    return {
      id: String(p._id),
      title: p.title,
      location: p.locationName || '',
      totalAmount: p.totalAmount,
      raised: summaries[i].raised,
      fundedAmount: summaries[i].fundedAmount,
      releasedAmount: summaries[i].releasedAmount,
      unfundedAmount: summaries[i].unfundedAmount,
      fundingMode: summaries[i].fundingMode,
      status: p.status,
      currentMilestone: current ? { title: current.name, status: current.status } : null,
      needsMyReview: awaitingProjectIds.has(String(p._id)),
    };
  });

  return {
    role: 'funder',
    stats: { totalFunded, activeProjects: activeCount, pendingReviews: awaiting.length },
    activeProjects,
    pendingReviews: awaiting.slice(0, LIST_LIMIT),
    newBrowsableProjectsThisWeek,
  };
}

// ── Contractor ───────────────────────────────────────────────────────────

/** Staged-funding view for a contractor's live contracts: how many awarded
 * projects are waiting on the funder to fund the next milestone (and the
 * contractor hasn't opted to proceed), and how much unfunded value they are
 * currently working on at their own risk ("Proceed Without Full Escrow"). */
async function contractorFundingStats(contractorObjectId) {
  const accepted = await Bid.find({ contractorId: contractorObjectId, status: 'accepted' }).select('projectId').lean();
  if (accepted.length === 0) return { awaitingFundingCount: 0, atRiskAmount: 0 };
  const projects = await Project.find({ _id: { $in: accepted.map((b) => b.projectId) }, status: { $in: ['funded', 'in_progress'] } })
    .select('totalAmount fundingMode milestones')
    .limit(50)
    .lean();
  let awaitingFundingCount = 0;
  let atRiskAmount = 0;
  for (const p of projects) {
    const state = await getFundingState(p);
    const next = state.milestones.find((m) => m.fundingStatus !== 'released');
    if (next && !next.workable) awaitingFundingCount += 1;
    for (const m of state.milestones) {
      if (m.proceedAtRisk && m.fundingStatus !== 'funded' && m.fundingStatus !== 'released') atRiskAmount += m.unfundedAmount;
    }
  }
  return { awaitingFundingCount, atRiskAmount: Math.round(atRiskAmount * 100) / 100 };
}

async function contractor(user) {
  const uid = toId(user._id);
  // Same widening "My bids" applies (bidController.getAll): a milestone
  // delegate also acts on their principal's bids, so the tile must count
  // exactly what that list shows.
  const delegated = await delegatedForIds(uid);
  const openBidMatch = { contractorId: { $in: [uid, ...delegated] }, status: 'submitted' };

  const [activeBids, openBidDocs, stats, payoutFilter, profile, myBidProjectIds, openTenderCount] = await Promise.all([
    Bid.countDocuments(openBidMatch),
    Bid.find(openBidMatch).populate('projectId', 'title').select('projectId price lastProposedBy').sort('-updatedAt').limit(LIST_LIMIT).lean(),
    contractorStatsService.getStats(uid),
    withdrawableFilter(user),
    ContractorProfile.findOne({ userId: uid }).select('categories').lean(),
    Bid.distinct('projectId', { contractorId: uid }),
    // Real platform-wide count, not the length of a 20-row page — mobile's
    // "Available Tenders" tile used to read useJobsQuery()'s own paginated
    // list length, silently capping at 20 once there were more open tenders
    // than that.
    Project.countDocuments({ projectType: 'tender', status: 'open' }),
  ]);
  const availablePayout = await sumXafNet(payoutFilter);
  const fundingStats = await contractorFundingStats(uid);

  // "Matching your trade" only when it genuinely matches one of the
  // contractor's own categories — otherwise it's honestly just the latest
  // open tender. Never one they own or have already bid on.
  const openTenderBase = { projectType: 'tender', status: 'open', ownerId: { $ne: uid }, _id: { $nin: myBidProjectIds } };
  const categories = profile?.categories || [];
  let featured = null;
  let featuredMatchesTrade = false;
  if (categories.length > 0) {
    featured = await Project.findOne({ ...openTenderBase, category: { $in: categories } }).select('title locationName totalAmount').sort('-createdAt').lean();
    featuredMatchesTrade = Boolean(featured);
  }
  if (!featured) {
    featured = await Project.findOne(openTenderBase).select('title locationName totalAmount').sort('-createdAt').lean();
  }
  const featuredBidCount = featured ? await Bid.countDocuments({ projectId: featured._id, status: { $ne: 'withdrawn' } }) : 0;

  return {
    role: 'contractor',
    stats: {
      activeBids,
      completedJobs: stats.completedProjects,
      rating: stats.avgRating == null ? null : Math.round(stats.avgRating * 10) / 10,
      ratingCount: stats.ratingCount,
      availablePayout,
      openTenderCount,
      awaitingFundingCount: fundingStats.awaitingFundingCount,
      atRiskAmount: fundingStats.atRiskAmount,
    },
    isKycVerified: user.kycStatus === 'verified',
    openBids: openBidDocs.map((b) => ({
      id: String(b._id),
      projectId: b.projectId ? String(b.projectId._id) : null,
      projectTitle: b.projectId?.title || 'Tender',
      price: b.price,
      // The funder countered and the next move is the contractor's.
      awaitingMyResponse: b.lastProposedBy === 'funder',
    })),
    featuredTender: featured
      ? {
          id: String(featured._id),
          title: featured.title,
          location: featured.locationName || '',
          budget: featured.totalAmount,
          bidCount: featuredBidCount,
          matchesTrade: featuredMatchesTrade,
        }
      : null,
  };
}

// ── Supplier (quincaillerie) ─────────────────────────────────────────────

async function supplier(user) {
  const profile = await SupplierProfile.findOne({ ownerId: user._id }).select('_id businessName applicationStatus').lean();
  const empty = { pendingOrders: 0, readyToShip: 0, outForDelivery: 0, completedOrders: 0, rating: null, ratingCount: 0, paidOut: 0 };
  if (!profile) return { role: 'supplier', hasProfile: false, applicationStatus: null, stats: empty };

  const [byStatus, rating, paidOut] = await Promise.all([
    countByStatus(MaterialOrder, { supplierId: profile._id }),
    // SupplierProfile.averageRating is never written anywhere, so the old
    // tile always read "—"; ratings live in the Rating collection.
    ratingSummary(user._id, 'supplier'),
    // Money actually paid to this store (releaseMilestoneEscrow routes a
    // materials milestone's payout to the supplier), not order value.
    sumXafNet({ type: 'release', payeeType: 'supplier', payeeSupplierId: profile._id, status: 'completed' }),
  ]);

  return {
    role: 'supplier',
    hasProfile: true,
    applicationStatus: profile.applicationStatus,
    stats: {
      pendingOrders: byStatus.requested || 0,
      readyToShip: byStatus.confirmed || 0,
      outForDelivery: byStatus.out_for_delivery || 0,
      // Live count, not the $inc-maintained SupplierProfile.completedOrderCount.
      completedOrders: byStatus.delivered || 0,
      rating: rating.average,
      ratingCount: rating.count,
      paidOut,
    },
  };
}

// ── Land seller ──────────────────────────────────────────────────────────

async function seller(user) {
  const uid = toId(user._id);
  const myListings = await LandListing.find({ sellerId: uid }).select('_id title verificationStatus titleType createdAt').sort('-createdAt').lean();
  const myListingIds = myListings.map((l) => l._id);
  const titleById = new Map(myListings.map((l) => [String(l._id), l.title]));

  // Offers ON this seller's listings only — never offers the seller made as
  // a buyer on someone else's land (mobile's old "Inquiries" counted those).
  const pendingOfferMatch = { listingId: { $in: myListingIds }, status: 'pending' };
  const [pendingOffers, pendingOfferDocs] = await Promise.all([
    LandOffer.countDocuments(pendingOfferMatch),
    LandOffer.find(pendingOfferMatch).select('listingId offerAmount message').sort('-createdAt').limit(LIST_LIMIT).lean(),
  ]);

  const firstUnverified = myListings.find((l) => l.verificationStatus !== 'verified');
  return {
    role: 'seller',
    stats: {
      listings: myListings.length,
      verifiedListings: myListings.filter((l) => l.verificationStatus === 'verified').length,
      pendingOffers,
    },
    pendingOffers: pendingOfferDocs.map((o) => ({
      id: String(o._id),
      listingId: String(o.listingId),
      listingTitle: titleById.get(String(o.listingId)) || 'Listing',
      amount: o.offerAmount,
      message: o.message || '',
    })),
    firstUnverifiedListing: firstUnverified
      ? { id: String(firstUnverified._id), title: firstUnverified.title, verificationStatus: firstUnverified.verificationStatus, titleType: firstUnverified.titleType || '' }
      : null,
  };
}

// ── Verifier ─────────────────────────────────────────────────────────────

async function verifier(user) {
  const uid = toId(user._id);
  const [byStatus, rating] = await Promise.all([
    countByStatus(VerificationTask, { verifierId: uid }),
    // Scoped to ratings received AS a verifier — a user who is also a
    // contractor must not see their contractor score blended in here.
    ratingSummary(uid, 'verifier'),
  ]);
  return {
    role: 'verifier',
    stats: {
      assigned: byStatus.assigned || 0,
      inProgress: byStatus.in_progress || 0,
      completed: byStatus.submitted || 0,
      rating: rating.average,
      ratingCount: rating.count,
    },
  };
}

// ── Admin (platform-wide) ────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAYS = 30;

function startOfCurrentMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** Dense day-by-day series over the last `days` days (today included),
 * zero-filled, so a chart never has to special-case missing days. */
function fillDailySeries(days, aggRows, valueKey) {
  const byDate = new Map(aggRows.map((r) => [r._id, r[valueKey]]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    out.push({ date: key, value: byDate.get(key) || 0 });
  }
  return out;
}

async function platform({ since } = {}) {
  const periodStart = since ? new Date(since) : startOfCurrentMonth();
  const trendSince = new Date(Date.now() - TREND_DAYS * DAY_MS);

  const [
    totalUsers, usersByRoleAgg, activeProjects, escrowByType, openDisputes, completedProjectsThisPeriod,
    newUsersByDayAgg, escrowVolumeByDayAgg,
  ] = await Promise.all([
    User.countDocuments({}),
    User.aggregate([{ $unwind: '$roles' }, { $group: { _id: '$roles.roleType', count: { $sum: 1 } } }]),
    Project.countDocuments({ status: { $in: ACTIVE_PROJECT_STATUSES } }),
    // Identical matching to getFundingSummaryData, platform-wide, so this
    // total always equals the sum of every project's own escrow balance. The
    // old version dropped `reversed` funds but still subtracted their
    // refunds — every refund was subtracted twice.
    Escrow.aggregate([
      { $match: { $or: [{ status: 'completed' }, { type: 'fund', status: 'reversed' }] } },
      { $group: { _id: '$type', total: { $sum: XAF_NET }, gross: { $sum: '$grossAmount' } } },
    ]),
    // Unresolved = not yet decided; 'under_review' is still open work.
    Dispute.countDocuments({ status: { $in: ['open', 'under_review'] } }),
    Project.countDocuments({ status: 'completed', updatedAt: { $gte: periodStart } }),
    User.aggregate([
      { $match: { createdAt: { $gte: trendSince } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
    ]),
    Escrow.aggregate([
      { $match: { type: 'fund', status: 'completed', createdAt: { $gte: trendSince } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: XAF_NET } } },
    ]),
  ]);

  const byType = Object.fromEntries(escrowByType.map((r) => [r._id, r.total]));
  // Releases consume escrow at the milestone's contract amount (gross) — the
  // release fee comes out of the payout — matching milestoneFundingService.
  const releasedGross = escrowByType.find((r) => r._id === 'release')?.gross || 0;
  const totalEscrowHeld = (byType.fund || 0) - (byType.refund || 0) - releasedGross;

  return {
    totalUsers,
    usersByRole: Object.fromEntries(usersByRoleAgg.map((r) => [r._id, r.count])),
    activeProjects,
    totalEscrowHeld: Math.round(totalEscrowHeld * 100) / 100,
    openDisputes,
    completedProjectsThisPeriod,
    since: periodStart,
    trends: {
      newUsersByDay: fillDailySeries(TREND_DAYS, newUsersByDayAgg, 'count'),
      escrowVolumeByDay: fillDailySeries(TREND_DAYS, escrowVolumeByDayAgg, 'total'),
    },
  };
}

const ROLE_BUILDERS = { funder, contractor, supplier, seller, verifier };

module.exports = { ROLE_BUILDERS, platform, milestonesAwaitingDecision };
