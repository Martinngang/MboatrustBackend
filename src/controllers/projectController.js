const mongoose = require('mongoose');
const { Project, Escrow, Dispute, Bid, RiskFlag, User, SupplierProfile, MaterialOrder } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const feeService = require('../services/feeService');
const conversionService = require('../services/conversionService');
const paymentService = require('../services/paymentService');
const storageService = require('../services/storageService');
const notificationService = require('../services/notificationService');
const evidenceAnalysisService = require('../services/evidenceAnalysisService');
const geocodingService = require('../services/geocodingService');
const referralService = require('../services/referralService');
const escrowAnomalyService = require('../services/escrowAnomalyService');
const { logAdminAction } = require('../services/adminActionLogService');

const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, projectType, status, ownerId, funderId, search } = req.query;
  const filter = {};
  if (projectType) filter.projectType = projectType;
  if (status) filter.status = status;
  if (ownerId) filter.ownerId = ownerId;
  // A funder never owns the project they fund — that's ownerId's role — so
  // "projects I've funded" can only be answered by looking at who actually
  // paid into escrow, not at the Project document itself.
  if (funderId) {
    const fundedProjectIds = await Escrow.distinct('projectId', { funderId, type: 'fund' });
    filter._id = { $in: fundedProjectIds };
  }
  // Free-text: title match, or owned by a user whose name matches — used by
  // the admin project list, but harmless/available to any caller (same
  // "no auth required to browse" posture as the rest of this endpoint).
  if (search) {
    const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    const matchingOwnerIds = await User.find({ fullName: pattern }).select('_id').lean();
    filter.$or = [{ title: pattern }, { ownerId: { $in: matchingOwnerIds.map((u) => u._id) } }];
  }

  const [items, total] = await Promise.all([
    Project.find(filter)
      .populate('ownerId', 'fullName')
      .populate('coSignerId', 'fullName')
      .populate('milestones.approvers.userId', 'fullName')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    Project.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getOne = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id)
    .populate('ownerId', 'fullName')
    .populate('coSignerId', 'fullName')
    .populate('milestones.approvers.userId', 'fullName');
  if (!project) throw ApiError.notFound('Project not found');
  return ok(res, project);
});

// Role-based separation: a tender is a Funder posting work for a contractor
// to bid on. Without this, POST /projects had no requireRole at all (it
// can't be a single static middleware since the *role required* depends on
// req.body.projectType, not the route) — any authenticated account,
// contractor included, could create a tender. 'funding' (the Recipient-role
// funding-request project type) is retired outright — the feature has been
// removed platform-wide, so creation is rejected unconditionally regardless
// of role; existing historical 'funding' projects remain readable via the
// normal getAll/getOne paths, they just can never be created again.
// land_purchase is deliberately left ungated here: it isn't part of this
// funder/contractor separation and this endpoint's existing behavior for it
// is unreviewed/unchanged.
function assertCanCreateProjectType(user, projectType) {
  const hasRole = (roleType) => user.roles?.some((r) => r.roleType === roleType);
  if (projectType === 'tender' && !hasRole('funder')) {
    throw ApiError.forbidden('Only a Project Funder can post a tender');
  }
  if (projectType === 'funding') {
    throw ApiError.forbidden('Funding-request projects are no longer supported');
  }
}

const create = catchAsync(async (req, res) => {
  assertCanCreateProjectType(req.user, req.body.projectType);
  const milestones = (req.body.milestones || []).sort((a, b) => a.orderIndex - b.orderIndex);
  const project = await Project.create({
    ...req.body,
    milestones,
    ownerId: req.user._id,
    status: 'open',
  });
  await project.populate('ownerId', 'fullName');
  return created(res, project);
});

/** Safe, real "close" — only permitted while the project has never received
 * funds or awarded a bid (still 'draft'/'open'). Cancelling after that needs
 * the real dispute/refund path, not a status flip, so this deliberately
 * can't reach a funded/in_progress project. Any still-open bids on a
 * cancelled tender are auto-rejected, mirroring bidController.updateStatus's
 * own accept-path convention. */
const cancel = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) throw ApiError.notFound('Project not found');
  if (String(project.ownerId) !== String(req.user._id)) throw ApiError.forbidden();
  if (!['draft', 'open'].includes(project.status)) {
    throw ApiError.conflict('Cannot cancel a project once it has received funds or awarded a bid');
  }

  project.status = 'cancelled';
  await project.save();

  const openBids = await Bid.find({ projectId: project._id, status: 'submitted' });
  if (openBids.length > 0) {
    await Bid.updateMany({ projectId: project._id, status: 'submitted' }, { status: 'rejected' });
    await Promise.all(
      openBids.map((b) => notificationService.notify(b.contractorId, 'bid_status_changed', { bidId: b._id, status: 'rejected' }))
    );
  }

  return ok(res, project);
});

const update = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) throw ApiError.notFound('Project not found');
  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  const isOwner = String(project.ownerId) === String(req.user._id);
  if (!isOwner && !isAdmin) throw ApiError.forbidden();
  // Applies to admin too — once real money has moved, editing core fields
  // (totalAmount, milestones) would desync the escrow ledger from what the
  // project document claims. Not an arbitrary restriction lifted for staff.
  if (project.status !== 'draft' && project.status !== 'open') {
    throw ApiError.conflict('Cannot edit a project once it has received funds');
  }
  Object.assign(project, req.body);
  await project.save();
  if (isAdmin && !isOwner) {
    await logAdminAction({ adminId: req.user._id, action: 'project.update', targetType: 'Project', targetId: project._id, detail: { fields: Object.keys(req.body) } });
  }
  return ok(res, project);
});

const remove = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) throw ApiError.notFound('Project not found');
  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  const isOwner = String(project.ownerId) === String(req.user._id);
  if (!isOwner && !isAdmin) throw ApiError.forbidden();
  if (project.status !== 'draft') throw ApiError.conflict('Only draft projects can be deleted');
  await project.deleteOne();
  if (isAdmin && !isOwner) {
    await logAdminAction({ adminId: req.user._id, action: 'project.remove', targetType: 'Project', targetId: project._id, detail: { title: project.title } });
  }
  return res.status(204).send();
});

/** Sum of completed escrow activity for a project, net of fees, used to derive "amount raised". */
/** Raw computation, factored out so groupController's dashboard can reuse it
 * without duplicating the aggregation — the route handler below is just a
 * thin wrapper. */
async function getFundingSummaryData(projectId) {
  const rows = await Escrow.aggregate([
    {
      $match: {
        projectId: new mongoose.Types.ObjectId(projectId),
        // A refunded fund transaction is flipped to 'reversed' (see
        // escrowController.refund) purely to block a second refund of the
        // same transaction — it still represents money that was actually
        // collected, so it must stay in the 'fund' sum or its paired
        // 'refund' entry double-subtracts and pushes "raised" negative.
        $or: [{ status: 'completed' }, { type: 'fund', status: 'reversed' }],
      },
    },
    { $group: { _id: '$type', total: { $sum: '$netAmount' } } },
  ]);
  const byType = Object.fromEntries(rows.map((r) => [r._id, r.total]));
  const raised = (byType.fund || 0) - (byType.refund || 0);
  const released = byType.release || 0;
  return { raised, released, escrowBalance: raised - released };
}

const getFundingSummary = catchAsync(async (req, res) => {
  const summary = await getFundingSummaryData(req.params.id);
  return ok(res, summary);
});

/**
 * Funder sends money into escrow for a project. Sandbox payment provider
 * "completes" synchronously for the demo; a real integration would move
 * status pending -> completed via a webhook instead.
 */
const fundProject = catchAsync(async (req, res) => {
  const { amount, paymentProvider, currency: requestedCurrency, payerPhoneNumber } = req.body;
  const project = await Project.findById(req.params.id);
  if (!project) throw ApiError.notFound('Project not found');
  const currency = requestedCurrency || project.currency;
  if (!['open', 'funded', 'in_progress'].includes(project.status)) {
    throw ApiError.conflict(`Cannot fund a project in status "${project.status}"`);
  }

  if (paymentProvider === 'mtn_momo' && !payerPhoneNumber) {
    throw ApiError.badRequest('Payer phone number is required for MTN MoMo funding');
  }

  if (['mtn_momo', 'orange_money'].includes(paymentProvider) && currency !== 'XAF') {
    throw ApiError.badRequest('Mobile money funding must be paid in XAF');
  }

  let conversion = null;
  if (currency !== 'XAF') {
    conversion = await conversionService.convertAmount(amount, currency, 'XAF');
  }

  const fee = await feeService.calculateFee('project_funding', amount, currency);
  const paymentResult = await paymentService.collect(paymentProvider, {
    amount,
    currency,
    payerPhoneNumber,
    externalId: `fund_${project._id}`,
    projectId: project._id,
    email: req.user?.email || '',
    fullName: req.user?.fullName || '',
    description: project.title,
  });

  const escrow = await Escrow.create({
    projectId: project._id,
    funderId: req.user._id,
    payerEmail: req.user?.email || null,
    type: 'fund',
    grossAmount: fee.grossAmount,
    feeBreakdown: { feeType: fee.feeType, feeRate: fee.feeRate, feeAmount: fee.feeAmount },
    netAmount: fee.netAmount,
    currency,
    paymentProvider,
    providerRole: 'collection',
    providerReference: paymentResult.providerReference,
    currencyConversion: conversion,
    status: paymentResult.status,
    statusHistory: [{ status: paymentResult.status, detail: 'escrow funded by user' }],
  });

  if (paymentResult.status === 'completed' && project.status === 'open') {
    project.status = 'funded';
    await project.save();
  }

  await notificationService.notify(project.ownerId, 'project_funded', {
    projectId: project._id,
    amount: fee.netAmount,
  });

  const responseBody = {
    ...escrow.toObject(),
    ...(paymentResult.paymentUrl ? { paymentUrl: paymentResult.paymentUrl } : {}),
    ...(paymentResult.clientSecret ? { clientSecret: paymentResult.clientSecret } : {}),
  };
  return created(res, responseBody);
});

async function releaseMilestoneEscrow(project, milestone) {
  // Closes (though the unique index below is the hard guarantee) the window
  // where two genuinely concurrent decideApproval calls both pass the
  // caller's status check and both reach here — without this, both would go
  // on to make a REAL disbursement API call and create two release escrows
  // for the same milestone, a real double-payout. Checked as early as
  // possible, before any side-effecting work.
  const existingRelease = await Escrow.findOne({ milestoneId: milestone._id, type: 'release' });
  if (existingRelease) {
    milestone.status = 'released';
    return existingRelease;
  }

  const payoutCurrency = 'XAF';
  let conversion = null;
  let disbursementGross = milestone.amount;

  // Tender projects have a real contractor party (whoever's Bid was
  // accepted) — funding/land_purchase projects don't, so this stays null there.
  let contractorId = null;
  if (project.projectType === 'tender') {
    const acceptedBid = await Bid.findOne({ projectId: project._id, status: 'accepted' })
      .select('contractorId')
      .lean();
    contractorId = acceptedBid?.contractorId || null;
  }

  // Real payee routing for a materials-managed milestone: if a supplier has
  // actually confirmed/dispatched/delivered an order against this exact
  // milestone by the time it's approved, the release pays that store
  // directly instead of the project's usual payee — mirroring what the
  // frontend's resolveMilestonePayee has only ever been able to *display*.
  // Every other milestone keeps today's existing behavior (payeePhoneNumber
  // null, a known pre-existing gap in the contractor disbursement path —
  // out of scope here, since fixing that needs a real payout-details
  // capture step for that actor that doesn't exist yet). The 'recipient'
  // fallback below is unreachable for any new project (funding-project
  // creation is retired, see assertCanCreateProjectType) but is kept as-is
  // so a still-open legacy funding project's milestone release keeps
  // producing a valid, historically-consistent payeeType.
  let payeeType = project.projectType === 'tender' ? 'contractor' : 'recipient';
  let payeeSupplierId = null;
  let payoutProvider = 'mtn_momo';
  let payeePhoneNumber = null;
  let payoutMethodId = null;
  const materialsOrder = await MaterialOrder.findOne({
    milestoneId: milestone._id,
    status: { $in: ['confirmed', 'out_for_delivery', 'delivered'] },
  }).select('supplierId');
  if (materialsOrder) {
    const supplier = await SupplierProfile.findById(materialsOrder.supplierId).select('paymentProvider payoutPhoneNumber');
    if (supplier) {
      payeeType = 'supplier';
      payeeSupplierId = supplier._id;
      payoutProvider = supplier.paymentProvider;
      payeePhoneNumber = supplier.payoutPhoneNumber || null;
    }
  } else {
    const targetUserId = payeeType === 'contractor' ? contractorId : project.ownerId;
    if (targetUserId) {
      const payeeUser = await User.findById(targetUserId).select('payoutMethods phoneNumber').lean();
      if (payeeUser) {
        const defaultMethod = payeeUser.payoutMethods?.find((m) => m.isDefault) || payeeUser.payoutMethods?.[0];
        if (defaultMethod) {
          payoutProvider = defaultMethod.provider;
          payeePhoneNumber = defaultMethod.phoneNumber;
          payoutMethodId = defaultMethod._id;
        } else if (payeeUser.phoneNumber) {
          payeePhoneNumber = payeeUser.phoneNumber;
        }
      }
    }
  }

  if (project.currency !== payoutCurrency) {
    conversion = await conversionService.convertAmount(milestone.amount, project.currency, payoutCurrency);
    disbursementGross = conversion.settledAmount;
  }

  const fee = await feeService.calculateFee('milestone_release', disbursementGross, payoutCurrency);
  const paymentResult = await paymentService.disburse(payoutProvider, {
    amount: fee.netAmount,
    currency: payoutCurrency,
    payeePhoneNumber,
    externalId: `release_${project._id}_${milestone._id}`,
  });

  let escrow;
  try {
    escrow = await Escrow.create({
      projectId: project._id,
      milestoneId: milestone._id,
      contractorId,
      payeeType,
      payeeSupplierId,
      payeePhoneNumber,
      payoutMethodId,
      type: 'release',
      grossAmount: fee.grossAmount,
      feeBreakdown: { feeType: fee.feeType, feeRate: fee.feeRate, feeAmount: fee.feeAmount },
      netAmount: fee.netAmount,
      currency: payoutCurrency,
      paymentProvider: payoutProvider,
      providerRole: 'disbursement',
      providerReference: paymentResult.providerReference,
      currencyConversion: conversion,
      status: paymentResult.status,
      statusHistory: [{ status: paymentResult.status, detail: 'milestone release disbursed' }],
    });
  } catch (err) {
    // The early check above already handles the common case — this only
    // fires in the rare true-simultaneous race that slips past it. The
    // unique index (see Escrow.js) is what actually guarantees no duplicate
    // ledger entry, not this catch; a real disbursement call may still have
    // already fired for the losing request, which is a payment-provider-side
    // limitation this codebase has no atomic primitive to prevent — but the
    // ledger itself stays correct, which is what matters for what gets paid
    // out from here on.
    if (err.code !== 11000) throw err;
    escrow = await Escrow.findOne({ milestoneId: milestone._id, type: 'release' });
  }

  milestone.status = 'released';
  return escrow;
}

/** Adds a photo/video evidence entry to a milestone and moves it into review. */
const submitEvidence = catchAsync(async (req, res) => {
  const { id, milestoneId } = req.params;
  const project = await Project.findById(id);
  if (!project) throw ApiError.notFound('Project not found');
  await assertProjectParty(project, req.user._id);
  const milestone = project.milestones.id(milestoneId);
  if (!milestone) throw ApiError.notFound('Milestone not found');
  // 'under_review' is included because a milestone's status flips there as
  // soon as its *first* evidence entry lands — a multi-photo submission is
  // one POST per file (see submitMilestoneProof on the frontend), so every
  // photo after the first would otherwise 409 against the status its own
  // predecessor just set.
  if (!['pending', 'submitted', 'under_review', 'disputed'].includes(milestone.status)) {
    throw ApiError.conflict(`Cannot submit evidence for a milestone in status "${milestone.status}"`);
  }

  let fileUrl = req.body.fileUrl;
  const clientGeotag =
    req.body.geotagLat != null && req.body.geotagLng != null ? { lat: req.body.geotagLat, lng: req.body.geotagLng } : null;
  // Server-computed signals from the actual file bytes — a client can't fake
  // its geotag/timestamp/hash by lying in the request body, only by faking
  // the file's own EXIF data, which is a materially higher bar.
  let analysis = { geotag: clientGeotag ?? { lat: null, lng: null }, fileHash: req.body.fileHash, locationMatch: null, timestampRecent: null, duplicateFlag: false, capturedAt: undefined };
  if (req.file) {
    const uploadResult = await storageService.uploadBuffer(req.file.buffer, {
      folder: `mboatrust/evidence/${project._id}`,
    });
    fileUrl = uploadResult.secure_url;
    analysis = await evidenceAnalysisService.analyzeEvidence(req.file.buffer, project.location, clientGeotag);
  }
  if (!fileUrl) throw ApiError.badRequest('Provide a file upload or fileUrl');

  // The client already resolves and shows a place name the moment it gets a
  // GPS fix (see MilestoneSubmitScreen), well before this upload — reusing
  // that value here avoids a second geocode call for the same coordinates
  // and keeps what the contractor saw during capture consistent with what
  // gets persisted. Only resolved server-side as a fallback (a client that
  // couldn't reach the geocoder, or an older client), so a real geotag
  // still ends up with a place name even without one included on the
  // request the same as always.
  let placeName = req.body.placeName || null;
  if (!placeName && analysis.geotag?.lat != null && analysis.geotag?.lng != null) {
    placeName = await geocodingService.reverseGeocode(analysis.geotag.lat, analysis.geotag.lng);
  }

  milestone.evidence.push({
    type: req.body.type,
    fileUrl,
    notes: req.body.notes || '',
    geotag: analysis.geotag,
    placeName,
    fileHash: analysis.fileHash,
    locationMatch: analysis.locationMatch,
    timestampRecent: analysis.timestampRecent,
    duplicateFlag: analysis.duplicateFlag,
    capturedAt: analysis.capturedAt,
    submittedBy: req.user._id,
  });
  milestone.status = 'under_review';

  if (project.status === 'funded') project.status = 'in_progress';
  await project.save();

  // Broadened from duplicateFlag-only: a geotag that doesn't match the
  // project's site, or a stale timestamp, is just as real a signal as a
  // reused file — all three now create a flag, not just the one that
  // happened to be wired up first. 'duplicate_geotag' was already declared
  // in the schema for exactly this kind of geo/time mismatch and had never
  // actually been triggered anywhere until now.
  const heuristicFlagType = analysis.duplicateFlag
    ? 'reused_evidence'
    : analysis.locationMatch === false || analysis.timestampRecent === false
    ? 'duplicate_geotag'
    : null;

  if (heuristicFlagType) {
    const riskFlag = await RiskFlag.create({
      userId: req.user._id,
      flagType: heuristicFlagType,
      severity: 'medium',
      detail: {
        projectId: project._id,
        milestoneId,
        fileHash: analysis.fileHash,
        locationMatch: analysis.locationMatch,
        timestampRecent: analysis.timestampRecent,
      },
    });

    // AI second opinion — only ever augments this already-created flag
    // (score + rationale, and severity can only go up), never creates its
    // own flag or blocks the response if it fails/is unconfigured.
    const aiOpinion = await evidenceAnalysisService.getAiSecondOpinion({
      analysis,
      project,
      milestone,
      fileUrl,
      evidenceType: req.body.type,
    });
    if (aiOpinion) {
      riskFlag.aiRiskScore = aiOpinion.riskScore;
      riskFlag.aiRationale = aiOpinion.rationale;
      if (aiOpinion.suspicious && riskFlag.severity !== 'high') riskFlag.severity = 'high';
      await riskFlag.save();
    }
  }

  await notificationService.notify(project.ownerId, 'milestone_evidence_submitted', {
    projectId: project._id,
    milestoneId,
  });

  return created(res, project);
});

/** Owner-only: designates the second required signer for this project's
 * requiresMultiSig flag and any milestone with requiresCosigner. Replaces
 * whichever co-signer was set before, if any — there is only ever one. */
const addCoSigner = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) throw ApiError.notFound('Project not found');
  if (String(project.ownerId) !== String(req.user._id)) throw ApiError.forbidden();

  const { coSignerId } = req.body;
  const coSigner = await require('../models').User.findById(coSignerId);
  if (!coSigner) throw ApiError.badRequest('No such user');
  if (String(coSignerId) === String(project.ownerId)) {
    throw ApiError.badRequest('The co-signer must be a different person than the project owner');
  }

  project.coSignerId = coSignerId;
  await project.save();
  await notificationService.notify(coSignerId, 'co_signer_added', { projectId: project._id });
  await project.populate('coSignerId', 'fullName');
  return ok(res, project);
});

/** Assigns (or, with supplierId: null, clears) the project's preferred
 * materials supplier — deliberately its own endpoint rather than folded into
 * `update` above: assigning a supplier is pure routing metadata that can
 * never desync an escrow ledger, so unlike totalAmount/milestones it must
 * stay legal at any project status, not just while still 'draft'/'open'.
 * This is what lets a funder browse/compare real supplier profiles
 * (inventory, pricing, location) via the dedicated assignment screen and
 * commit to one whenever they're ready — not forced into the choice at
 * project-creation time. */
const assignSupplier = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) throw ApiError.notFound('Project not found');
  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  if (String(project.ownerId) !== String(req.user._id) && !isAdmin) throw ApiError.forbidden();

  const { supplierId } = req.body;
  if (supplierId) {
    const supplier = await SupplierProfile.findById(supplierId).select('_id applicationStatus');
    if (!supplier) throw ApiError.notFound('Supplier not found');
    if (supplier.applicationStatus !== 'approved') throw ApiError.badRequest('This supplier is not approved yet');
    project.materialsManagedBy = 'supplier';
    project.preferredSupplierId = supplierId;
  } else {
    project.materialsManagedBy = 'contractor';
    project.preferredSupplierId = null;
  }
  await project.save();
  return ok(res, project);
});

/** Every userId that must have an 'approved' entry in milestone.approvers
 * before it can move to approved/released. Plain single-approver default
 * when neither flag is set — completely unchanged from before this prompt. */
function requiredApproverIds(project, milestone) {
  if (!milestone.requiresCosigner && !project.requiresMultiSig) return null; // "any one approver" path
  if (!project.coSignerId) {
    throw ApiError.conflict(
      'This milestone requires a co-signer, but none has been added to this project yet — add one via POST /projects/:id/co-signer first.'
    );
  }
  return [String(project.ownerId), String(project.coSignerId)];
}

/**
 * Records an approver's decision. Auto-registers the acting user as an
 * approver on first decision (e.g. the funder reviewing evidence) rather
 * than requiring a separate pre-assignment step.
 */
/** The actual decision logic, applied to an already-loaded project/milestone
 * — factored out so decideApproval can re-apply it to a freshly-reloaded
 * document on a concurrent-write conflict (see the retry loop below) without
 * duplicating the rules for what "this user approved" means on top of a
 * document someone else already modified. */
async function applyApprovalDecision(req, project, milestone) {
  if (milestone.status !== 'under_review' && milestone.status !== 'submitted') {
    throw ApiError.conflict(`Milestone is not awaiting approval (status "${milestone.status}")`);
  }

  const { status } = req.body;
  const required = requiredApproverIds(project, milestone);
  if (required) {
    if (!required.includes(String(req.user._id))) {
      throw ApiError.forbidden('Only the project owner or its designated co-signer may decide this milestone');
    }
  } else if (String(req.user._id) !== String(project.ownerId)) {
    // The single-approver default has exactly one authorized decider:
    // project.ownerId — same "ownerId is the authoritative party regardless
    // of pillar" rule update/cancel/assignSupplier already apply (the funder
    // for a tender, consistent with the multisig path just above also
    // pairing ownerId with the co-signer rather than inventing a separate
    // "funder" identity). Without
    // this check, any authenticated caller at all — including the
    // contractor/awarded party whose own work is under review — could
    // register themselves as the sole approver and release real escrowed
    // money to themselves.
    throw ApiError.forbidden('Only the project owner may decide this milestone');
  }

  let approver = milestone.approvers.find((a) => String(a.userId) === String(req.user._id));
  if (!approver) {
    milestone.approvers.push({ userId: req.user._id, status, decidedAt: new Date() });
  } else {
    approver.status = status;
    approver.decidedAt = new Date();
  }

  let releasedEscrow = null;
  if (status === 'rejected') {
    milestone.status = 'disputed';
  } else if (required) {
    // Co-signer / multi-sig path: every required identity (owner + co-signer)
    // must have its own 'approved' entry — one person approving is not enough.
    const allRequiredApproved = required.every((uid) =>
      milestone.approvers.some((a) => String(a.userId) === uid && a.status === 'approved')
    );
    if (allRequiredApproved) {
      milestone.status = 'approved';
      releasedEscrow = await releaseMilestoneEscrow(project, milestone);
    }
  } else {
    // Original single-approver default, unchanged.
    const allApproved =
      milestone.approvers.length > 0 && milestone.approvers.every((a) => a.status === 'approved');
    if (allApproved || milestone.approvers.length === 0) {
      milestone.status = 'approved';
      releasedEscrow = await releaseMilestoneEscrow(project, milestone);
    }
  }

  const allReleased = project.milestones.every((m) => m.status === 'released');
  const justCompleted = allReleased && project.status !== 'completed';
  if (allReleased) project.status = 'completed';

  return { releasedEscrow, justCompleted };
}

const decideApproval = catchAsync(async (req, res) => {
  const { id, milestoneId } = req.params;

  // Two genuinely concurrent decisions on the same milestone (a double-tap,
  // a client retry, or a real multi-sig owner+co-signer race) both load the
  // same project document — Mongoose's version check on save() means only
  // the first one to save can win, and the second would otherwise surface a
  // raw VersionError as an unhandled 500. Retrying against a freshly-loaded
  // document re-applies THIS request's own decision on top of whatever the
  // other one already committed, rather than silently dropping it — that
  // matters for multi-sig, where the loser's approval is real, distinct
  // information, not a duplicate of the winner's.
  const MAX_ATTEMPTS = 3;
  let project, milestone, releasedEscrow, justCompleted;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    project = await Project.findById(id);
    if (!project) throw ApiError.notFound('Project not found');
    milestone = project.milestones.id(milestoneId);
    if (!milestone) throw ApiError.notFound('Milestone not found');

    ({ releasedEscrow, justCompleted } = await applyApprovalDecision(req, project, milestone));

    try {
      await project.save();
      break;
    } catch (err) {
      if (err.name !== 'VersionError' || attempt === MAX_ATTEMPTS) throw err;
    }
  }

  await notificationService.notify(project.ownerId, 'milestone_decision', {
    projectId: project._id,
    milestoneId,
    status: milestone.status,
  });

  // Detection-only — runs after the release is already persisted, never
  // able to delay or block the payout itself, and never touches the
  // double-spend guard above. See escrowAnomalyService.
  if (releasedEscrow) {
    await escrowAnomalyService.checkAndFlag({
      escrow: releasedEscrow,
      beneficiaryId: releasedEscrow.contractorId || project.ownerId,
    });
  }

  if (justCompleted) {
    // A prompt, not an auto-generated rating — never fabricate one on
    // someone's behalf. Reward the referrer of whichever party just
    // finished their side of the work, if either was ever referred.
    await notificationService.notify(project.ownerId, 'rating_prompt', { projectId: project._id });
    await referralService.maybeRewardReferral(project.ownerId);

    if (project.projectType === 'tender') {
      const acceptedBid = await Bid.findOne({ projectId: project._id, status: 'accepted' }).select('contractorId').lean();
      if (acceptedBid) {
        await notificationService.notify(acceptedBid.contractorId, 'rating_prompt', { projectId: project._id });
        await referralService.maybeRewardReferral(acceptedBid.contractorId);
      }
    }
  }

  return ok(res, { project, releasedEscrow });
});

/** Is this user a real party to this project — the owner (funder on a
 * tender; the project's own owner on a land_purchase project, or a legacy
 * funding project — that project type is retired), its co-signer, or
 * (tender-only) the contractor whose bid was accepted? Shared by
 * disputeMilestone and requestMilestoneChanges — neither previously checked
 * this at all, which let any authenticated stranger dispute or send back a
 * project they had nothing to do with. */
async function assertProjectParty(project, userId) {
  const uid = String(userId);
  if (String(project.ownerId) === uid) return;
  if (project.coSignerId && String(project.coSignerId) === uid) return;
  if (project.projectType === 'tender') {
    const acceptedBid = await Bid.findOne({ projectId: project._id, status: 'accepted', contractorId: userId }).select('_id').lean();
    if (acceptedBid) return;
  }
  throw ApiError.forbidden('Not authorized to act on this project');
}

/** Raises a formal dispute against a milestone (or the whole project when milestoneId is omitted). */
const disputeMilestone = catchAsync(async (req, res) => {
  const { id, milestoneId } = req.params;
  const { reason } = req.body;
  const project = await Project.findById(id);
  if (!project) throw ApiError.notFound('Project not found');
  await assertProjectParty(project, req.user._id);

  if (milestoneId) {
    const milestone = project.milestones.id(milestoneId);
    if (!milestone) throw ApiError.notFound('Milestone not found');
    milestone.status = 'disputed';
  }
  project.status = 'disputed';
  await project.save();

  const dispute = await Dispute.create({
    projectId: project._id,
    milestoneId: milestoneId || null,
    raisedBy: req.user._id,
    reason,
  });

  return created(res, dispute);
});

/** A lighter-weight alternative to a formal dispute: the project owner (or
 * co-signer, same authority decideApproval respects) sends a submitted
 * milestone back to 'pending' with a reason instead of escalating — no
 * money moves, the contractor can just resubmit evidence. Every
 * round is kept in `changeRequests`, not just the latest, so both sides see
 * the full back-and-forth. Clearing `approvers` matters: without it, a
 * stale 'approved' entry from *before* this round would let the next
 * decideApproval call auto-release the instant the milestone reaches
 * under_review again, without anyone actually deciding that round. */
const requestMilestoneChanges = catchAsync(async (req, res) => {
  const { id, milestoneId } = req.params;
  const { reason } = req.body;
  const project = await Project.findById(id);
  if (!project) throw ApiError.notFound('Project not found');
  const milestone = project.milestones.id(milestoneId);
  if (!milestone) throw ApiError.notFound('Milestone not found');

  const required = requiredApproverIds(project, milestone);
  const authorized = required ? required.includes(String(req.user._id)) : String(req.user._id) === String(project.ownerId);
  if (!authorized) throw ApiError.forbidden('Only the project owner (or its designated co-signer) may request changes');

  if (milestone.status !== 'under_review' && milestone.status !== 'submitted') {
    throw ApiError.conflict(`Cannot request changes on a milestone in status "${milestone.status}"`);
  }

  milestone.status = 'pending';
  milestone.approvers = [];
  milestone.changeRequests.push({ reason, requestedBy: req.user._id });
  await project.save();

  const notifyTarget = project.projectType === 'tender'
    ? (await Bid.findOne({ projectId: project._id, status: 'accepted' }).select('contractorId').lean())?.contractorId
    : project.ownerId;
  if (notifyTarget) {
    await notificationService.notify(notifyTarget, 'milestone_changes_requested', { projectId: project._id, milestoneId, reason });
  }

  return ok(res, project);
});

module.exports = {
  getAll,
  getOne,
  create,
  update,
  cancel,
  remove,
  getFundingSummary,
  fundProject,
  submitEvidence,
  decideApproval,
  disputeMilestone,
  requestMilestoneChanges,
  addCoSigner,
  assignSupplier,
  getFundingSummaryData,
};
