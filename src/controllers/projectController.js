const mongoose = require('mongoose');
const { Project, Escrow, Dispute, Bid, RiskFlag, User, SupplierProfile, MaterialOrder, TeamMember, VerifierProfile, VerificationTask, MilestoneRiskAcknowledgement } = require('../models');
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
const { resolveLocationDetails } = require('../services/locationDetailsService');
const systemEventService = require('../services/systemEventService');
const referralService = require('../services/referralService');
const escrowAnomalyService = require('../services/escrowAnomalyService');
const { logAdminAction } = require('../services/adminActionLogService');
const { logTeamActivity } = require('../services/teamActivityLogService');
const { getRecommendedVerifiers } = require('../services/verifierMatchingService');
const { getFundingState, assertMilestoneWorkable, quoteFunding, handleFundCompleted, findAcceptedContractorId, EPS } = require('../services/milestoneFundingService');
const { releaseIfFunded, finalizeReleases } = require('../services/milestoneReleaseService');

/** Public supplier summary for projects that have one selected — only the
 * business-facing fields a contractor needs to see ("who's supplying
 * materials"), never the supplier's owner/contact details. Added alongside
 * `preferredSupplierId` (which stays a plain id for existing consumers)
 * rather than populating it in place. */
async function withSupplierSummary(docs) {
  const list = Array.isArray(docs) ? docs : [docs];
  const ids = [...new Set(list.map((p) => p.preferredSupplierId).filter(Boolean).map(String))];
  const suppliers = ids.length ? await SupplierProfile.find({ _id: { $in: ids } }).select('businessName region').lean() : [];
  const byId = new Map(suppliers.map((s) => [String(s._id), { id: s._id, businessName: s.businessName, region: s.region }]));
  const out = list.map((p) => {
    const obj = typeof p.toObject === 'function' ? p.toObject() : p;
    obj.supplier = p.preferredSupplierId ? byId.get(String(p.preferredSupplierId)) ?? null : null;
    return obj;
  });
  return Array.isArray(docs) ? out : out[0];
}

/** Validates a funder-selected supplier (must exist and be approved) and
 * returns the field set to apply — shared by tender creation and the
 * post-creation assign endpoint so both enforce identical rules. Never
 * auto-picks a supplier: have_supplier requires an explicit id. */
async function resolveSupplierChoice({ supplierRequirement, supplierId }) {
  // An explicit supplierId with no stated requirement keeps the older
  // assign-supplier contract (a bare supplierId means "use this supplier").
  const wantsSupplier = supplierRequirement === 'have_supplier' || (!supplierRequirement && Boolean(supplierId));
  if (wantsSupplier) {
    if (!supplierId) throw ApiError.badRequest('Select a supplier, or choose "I need a Supplier" instead');
    const supplier = await SupplierProfile.findById(supplierId).select('_id ownerId applicationStatus');
    if (!supplier) throw ApiError.notFound('Supplier not found');
    if (supplier.applicationStatus !== 'approved') throw ApiError.badRequest('This supplier is not approved yet');
    return { fields: { supplierRequirement: 'have_supplier', materialsManagedBy: 'supplier', preferredSupplierId: supplier._id }, supplier };
  }
  const requirement = supplierRequirement === 'need_supplier' ? 'need_supplier' : 'none';
  return { fields: { supplierRequirement: requirement, materialsManagedBy: 'contractor', preferredSupplierId: null }, supplier: null };
}

const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, projectType, status, ownerId, funderId, search } = req.query;
  const filter = {};
  if (projectType) filter.projectType = projectType;
  if (status) filter.status = status;
  if (ownerId) filter.ownerId = ownerId;
  // A funder never owns the project they fund — that's ownerId's role — so
  // "projects I've funded" can only be answered by looking at who actually
  // paid into escrow, not at the Project document itself. Only a `completed`
  // fund counts: a pending/failed payment never moved money, and a
  // `reversed` one was refunded back to the funder.
  if (funderId) {
    const fundedProjectIds = await Escrow.distinct('projectId', { funderId, type: 'fund', status: 'completed' });
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
  return ok(res, await withSupplierSummary(items), { page: Number(page), limit: Number(limit), total });
});

const getOne = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id)
    .populate('ownerId', 'fullName')
    .populate('coSignerId', 'fullName')
    .populate('milestones.approvers.userId', 'fullName')
    // Lets the funder tell a delegate's submission apart from the
    // contractor's own — see submitEvidence's TeamMember delegate check.
    .populate('milestones.evidence.submittedBy', 'fullName');
  if (!project) throw ApiError.notFound('Project not found');
  return ok(res, await withSupplierSummary(project));
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
  // A manual pin (client sent `location`) always wins — only geocode when
  // the client left it unset but gave us a human-readable place name to
  // resolve. Never blocks/fails project creation on a geocoding miss: the
  // project is just created with location still null, same as today,
  // correctable later via PATCH /:id/location.
  let location = req.body.location;
  let locationDetails;
  if (!location?.lat && !location?.lng && req.body.locationName) {
    const resolved = await geocodingService.forwardGeocode(req.body.locationName);
    if (resolved) {
      location = { lat: resolved.lat, lng: resolved.lng };
      locationDetails = {
        placeName: resolved.placeName,
        formattedAddress: resolved.formattedAddress,
        source: 'geocoded_search',
        resolvedAt: new Date(),
      };
    }
  } else if (location?.lat != null && location?.lng != null) {
    // A manual pin (or GPS fix) sent straight from the client — never store
    // it without also attempting to resolve a place name/address.
    locationDetails = await resolveLocationDetails({
      lat: location.lat,
      lng: location.lng,
      placeName: req.body.placeName,
      formattedAddress: req.body.formattedAddress,
      source: req.body.locationSource || 'manual_pin',
    });
  }
  // Supplier requirement — nothing is ever auto-assigned: a supplier is only
  // attached when the funder explicitly chose "I already have a Supplier".
  const { supplierRequirement: _req, preferredSupplierId: _sid, ...rest } = req.body;
  const { fields: supplierFields, supplier: chosenSupplier } = await resolveSupplierChoice({
    supplierRequirement: req.body.supplierRequirement,
    supplierId: req.body.preferredSupplierId,
  });
  const project = await Project.create({
    ...rest,
    ...supplierFields,
    location,
    locationDetails,
    milestones,
    ownerId: req.user._id,
    status: 'open',
  });
  if (chosenSupplier) {
    await notificationService.notify(chosenSupplier.ownerId, 'supplier_selected_for_project', {
      projectId: project._id,
      projectTitle: project.title,
    });
  }
  await project.populate('ownerId', 'fullName');
  // A new tender has no natural notify() recipient (it's a public posting,
  // not an event aimed at a specific person) — broadcast it the same way
  // presence:online/offline already is, so an open jobs/browse list can
  // pick it up live instead of waiting for a remount.
  if (project.projectType === 'tender') {
    req.app.get('io')?.emit('project:created', { id: project._id, projectType: project.projectType });
  }
  return created(res, await withSupplierSummary(project));
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

// Lives in services/fundingSummaryService.js (so services can reuse it
// without importing a controller); still re-exported below for
// groupController's dashboard.
const { getFundingSummaryData } = require('../services/fundingSummaryService');

const getFundingSummary = catchAsync(async (req, res) => {
  // getFundingSummaryData builds the ObjectId by hand for its $match, which
  // bypasses Mongoose's CastError — a malformed id used to 500 here.
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.badRequest('Invalid project id');
  const summary = await getFundingSummaryData(req.params.id);
  return ok(res, summary);
});

/** "Fee on top" quote: what the funder must pay for `netAmount` to be
 * credited to escrow. Single source of fee maths for web and mobile. */
const getFundingQuote = catchAsync(async (req, res) => {
  const netAmount = Number(req.query.netAmount);
  const currency = req.query.currency || 'XAF';
  if (!Number.isFinite(netAmount) || netAmount <= 0) throw ApiError.badRequest('netAmount must be a positive number');
  const project = await Project.findById(req.params.id).select('_id');
  if (!project) throw ApiError.notFound('Project not found');
  return ok(res, await quoteFunding(netAmount, currency));
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

  // Never let escrow exceed the agreed contract value. Compared on what will
  // actually be credited (net of the funding fee, XAF-converted) — the client
  // asks /funding-quote for the gross to pay for a given credited amount.
  const fundingState = await getFundingState(project);
  const creditedCoverage = fee.netAmount * (conversion?.rate ?? 1);
  if (creditedCoverage > fundingState.unfundedAmount + EPS) {
    throw ApiError.badRequest(
      `This payment would credit ${Math.round(creditedCoverage)} to escrow but only ${fundingState.unfundedAmount} of the ${fundingState.totalContractValue} contract value is still unfunded.`,
      { code: 'EXCEEDS_REMAINING_TO_FUND', remainingToFund: fundingState.unfundedAmount }
    );
  }

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

  if (paymentResult.status === 'completed') {
    await handleFundCompleted(project, escrow);
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

/** Adds a photo/video evidence entry to a milestone and moves it into review. */
const submitEvidence = catchAsync(async (req, res) => {
  const { id, milestoneId } = req.params;
  const project = await Project.findById(id);
  if (!project) throw ApiError.notFound('Project not found');
  const party = await assertProjectParty(project, req.user._id, { allowDelegate: true });
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
  // Work only proceeds on a funded milestone — or one the contractor has
  // explicitly chosen to work on at their own risk (proceedAtRisk).
  assertMilestoneWorkable(await getFundingState(project), milestone._id);

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
    // Prefer the milestone's own location when set (a multi-site project's
    // milestone may be far from the project's overall pin) — falls back to
    // the project's location, same as before this field existed.
    const expectedLocation =
      milestone.location?.lat != null && milestone.location?.lng != null ? milestone.location : project.location;
    analysis = await evidenceAnalysisService.analyzeEvidence(req.file.buffer, expectedLocation, clientGeotag);
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
  let formattedAddress = req.body.formattedAddress || null;
  // clientGeotag came straight off the device's own GPS fix; when it's
  // absent but the analysis still found coordinates, those were pulled from
  // the file's EXIF data instead — 'auto_detected', not a live GPS read.
  const geoSource = clientGeotag ? 'gps' : 'auto_detected';
  if (!placeName && analysis.geotag?.lat != null && analysis.geotag?.lng != null) {
    const resolved = await geocodingService.reverseGeocode(analysis.geotag.lat, analysis.geotag.lng);
    placeName = resolved?.placeName || null;
    formattedAddress = resolved?.formattedAddress || null;
  }

  milestone.evidence.push({
    type: req.body.type,
    fileUrl,
    notes: req.body.notes || '',
    geotag: analysis.geotag,
    placeName,
    formattedAddress,
    source: geoSource,
    captureSource: req.body.captureSource,
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

  // Non-blocking audit trail — every AR-camera capture (and, for completeness,
  // every gallery upload) is recorded with the ids a later audit needs,
  // regardless of whether anything else about the submission looked
  // suspicious. Never awaited into the response path on failure — same
  // "record it, never fail the request over it" contract every other
  // logEvent call site in this codebase already follows.
  systemEventService.logEvent({
    type: 'milestone_evidence_captured',
    severity: 'info',
    source: 'projectController.submitEvidence',
    userId: req.user._id,
    detail: {
      projectId: project._id,
      milestoneId,
      evidenceType: req.body.type,
      captureSource: req.body.captureSource,
    },
  }).catch(() => {});

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

  let submitterName = null;
  if (party.via === 'delegate') {
    const submitter = await User.findById(req.user._id).select('fullName').lean();
    submitterName = submitter?.fullName || null;
    await logTeamActivity({
      ownerId: party.contractorId,
      actorId: req.user._id,
      action: 'milestone.submittedOnBehalf',
      targetType: 'Project',
      targetId: project._id,
      detail: { milestoneId, milestoneName: milestone.name },
    });
  }

  await notificationService.notify(project.ownerId, 'milestone_evidence_submitted', {
    projectId: project._id,
    milestoneId,
    milestoneName: milestone.name,
    submittedByName: submitterName,
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

  const { supplierId, supplierRequirement } = req.body;
  const previousSupplierId = project.preferredSupplierId ? String(project.preferredSupplierId) : null;
  const { fields, supplier } = await resolveSupplierChoice({ supplierRequirement, supplierId });
  Object.assign(project, fields);
  await project.save();
  // Only tell the supplier when they're newly selected — re-saving the same
  // choice (or clearing it) shouldn't ping anyone.
  if (supplier && String(supplier._id) !== previousSupplierId) {
    await notificationService.notify(supplier.ownerId, 'supplier_selected_for_project', {
      projectId: project._id,
      projectTitle: project.title,
    });
  }
  return ok(res, await withSupplierSummary(project));
});

/** Dedicated endpoint, same reasoning as assignSupplier above — a pin
 * correction is metadata, never money, so it must stay legal at any project
 * status, not just while still 'draft'/'open' like the generic update
 * (which blocks all edits once funded, to protect the escrow ledger). */
const updateLocation = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) throw ApiError.notFound('Project not found');
  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  if (String(project.ownerId) !== String(req.user._id) && !isAdmin) throw ApiError.forbidden();

  project.location = req.body.location;
  // A manual pin correction here is exactly the "manual map selection" case
  // — never persist it without also attempting to resolve a place name.
  if (req.body.location?.lat != null && req.body.location?.lng != null) {
    project.locationDetails = await resolveLocationDetails({
      lat: req.body.location.lat,
      lng: req.body.location.lng,
      placeName: req.body.placeName,
      formattedAddress: req.body.formattedAddress,
      source: req.body.locationSource || 'manual_pin',
    });
  } else {
    project.locationDetails = undefined;
  }
  await project.save();
  return ok(res, project);
});

/** Same as updateLocation above, scoped to one milestone's own location
 * rather than the project's overall one — see MilestoneSchema.location in
 * models/Project.js. */
const updateMilestoneLocation = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) throw ApiError.notFound('Project not found');
  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  if (String(project.ownerId) !== String(req.user._id) && !isAdmin) throw ApiError.forbidden();

  const milestone = project.milestones.id(req.params.milestoneId);
  if (!milestone) throw ApiError.notFound('Milestone not found');

  milestone.location = req.body.location;
  if (req.body.location?.lat != null && req.body.location?.lng != null) {
    milestone.locationDetails = await resolveLocationDetails({
      lat: req.body.location.lat,
      lng: req.body.location.lng,
      placeName: req.body.placeName,
      formattedAddress: req.body.formattedAddress,
      source: req.body.locationSource || 'manual_pin',
    });
  } else {
    milestone.locationDetails = undefined;
  }
  await project.save();
  return ok(res, project);
});

/** Roles allowed to see the real plan-document URL — the owner, an admin,
 * a co-signer, or anyone with the contractor/verifier role (browsing an
 * open tender to decide whether to bid, or assigned to inspect the site —
 * "during tender review" per the feature request). Deliberately NOT
 * restricted to contractors who already bid: the plan is exactly what a
 * contractor needs to decide whether to bid in the first place. */
function canViewPlanDocument(user, project) {
  if (String(project.ownerId) === String(user._id)) return true;
  if (project.coSignerId && String(project.coSignerId) === String(user._id)) return true;
  return Boolean(user.roles?.some((r) => ['admin', 'contractor', 'verifier'].includes(r.roleType)));
}

/** Uploads (or replaces) the project's plan document — mirrors
 * landListingController.addDocument almost exactly. Owner/admin only.
 * Deliberately a follow-up endpoint, not part of project creation itself:
 * POST /projects is plain JSON (no multer), shared unchanged by both
 * frontends' PostJobScreen. */
const uploadPlanDocument = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) throw ApiError.notFound('Project not found');
  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  if (String(project.ownerId) !== String(req.user._id) && !isAdmin) throw ApiError.forbidden();
  if (!req.file) throw ApiError.badRequest('No file uploaded');

  const uploadResult = await storageService.uploadBuffer(req.file.buffer, {
    folder: `mboatrust/project-plans/${project._id}`,
    mimeType: req.file.mimetype,
  });

  project.planDocument = {
    fileUrl: uploadResult.secure_url,
    fileName: req.file.originalname || '',
    mimeType: req.file.mimetype || '',
    uploadedAt: new Date(),
  };
  project.hasPlanDocument = true;
  project.hasExistingPlan = true;
  await project.save();
  return created(res, { hasPlanDocument: true });
});

/** The only code path that ever reads the select:false `planDocument`
 * field — everything else (getOne/getAll/update/create) never sees it,
 * automatically, per the schema. */
const getPlanDocument = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id).select('+planDocument ownerId coSignerId');
  if (!project) throw ApiError.notFound('Project not found');
  if (!canViewPlanDocument(req.user, project)) throw ApiError.forbidden();
  if (!project.planDocument) throw ApiError.notFound('No plan document uploaded for this project');
  return ok(res, project.planDocument);
});

/** Funder-initiated — deliberately a NEW dedicated endpoint rather than
 * loosening the existing admin-only POST /verification-tasks (see
 * verificationController.create): a funder may only ever request
 * verification of their OWN project's location, never assign an arbitrary
 * verifier to an arbitrary target the way an admin can. */
const requestLocationVerification = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) throw ApiError.notFound('Project not found');
  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  if (String(project.ownerId) !== String(req.user._id) && !isAdmin) throw ApiError.forbidden();

  const verifierProfile = await VerifierProfile.findOne({ userId: req.body.verifierId }).select('applicationStatus');
  if (!verifierProfile || verifierProfile.applicationStatus !== 'approved') {
    throw ApiError.badRequest('This verifier is not approved yet');
  }

  const task = await VerificationTask.create({
    targetType: 'project_location',
    targetId: project._id,
    verifierId: req.body.verifierId,
  });
  project.locationVerificationStatus = 'requested';
  project.locationVerificationTaskId = task._id;
  await project.save();

  await notificationService.notify(req.body.verifierId, 'verification_assigned', {
    taskId: task._id,
    targetType: task.targetType,
    targetId: task.targetId,
  });

  return created(res, { task, project });
});

/** Owner-only thin wrapper over the shared verifier-matching/scoring
 * engine, scoped to this one project — same engine the admin-only
 * getRecommendedVerifiersForTarget endpoint already uses for
 * milestones/land listings, just reachable by the project's own owner
 * instead of only an admin. */
const getRecommendedVerifiersForProject = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id).select('ownerId');
  if (!project) throw ApiError.notFound('Project not found');
  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  if (String(project.ownerId) !== String(req.user._id) && !isAdmin) throw ApiError.forbidden();

  const recommendations = await getRecommendedVerifiers('project_location', project._id, { limit: Number(req.query.limit) || 10 });
  return ok(res, recommendations);
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
  let awaitingFunds = false;
  let shortfall = 0;
  // Approval is the funder's decision; the money can only move if escrow
  // actually holds the milestone's amount. If it doesn't, the milestone stays
  // `approved` (work accepted, payment owed) and is released automatically the
  // moment the funder tops up — see settleApprovedMilestones.
  const approveAndRelease = async () => {
    milestone.status = 'approved';
    ({ escrow: releasedEscrow, awaitingFunds, shortfall } = await releaseIfFunded(project, milestone));
  };
  if (status === 'rejected') {
    milestone.status = 'disputed';
  } else if (required) {
    // Co-signer / multi-sig path: every required identity (owner + co-signer)
    // must have its own 'approved' entry — one person approving is not enough.
    const allRequiredApproved = required.every((uid) =>
      milestone.approvers.some((a) => String(a.userId) === uid && a.status === 'approved')
    );
    if (allRequiredApproved) await approveAndRelease();
  } else {
    // Original single-approver default, unchanged.
    const allApproved =
      milestone.approvers.length > 0 && milestone.approvers.every((a) => a.status === 'approved');
    if (allApproved || milestone.approvers.length === 0) await approveAndRelease();
  }

  const allReleased = project.milestones.every((m) => m.status === 'released');
  const justCompleted = allReleased && project.status !== 'completed';
  if (allReleased) project.status = 'completed';

  return { releasedEscrow, justCompleted, awaitingFunds, shortfall };
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
  let project, milestone, releasedEscrow, justCompleted, awaitingFunds, shortfall;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    project = await Project.findById(id);
    if (!project) throw ApiError.notFound('Project not found');
    milestone = project.milestones.id(milestoneId);
    if (!milestone) throw ApiError.notFound('Milestone not found');

    ({ releasedEscrow, justCompleted, awaitingFunds, shortfall } = await applyApprovalDecision(req, project, milestone));

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

  if (awaitingFunds) {
    // The funder approved the work but escrow doesn't yet hold the milestone
    // amount: nothing is released (and nothing is guaranteed) until they top
    // up — at which point settleApprovedMilestones pays it automatically.
    const contractorId = await findAcceptedContractorId(project);
    const payload = { projectId: project._id, milestoneId, milestoneName: milestone.name, amount: milestone.amount, shortfall };
    await notificationService.notify(project.ownerId, 'milestone_awaiting_funds', payload);
    if (contractorId) await notificationService.notify(contractorId, 'milestone_awaiting_funds', payload);
  }

  // Anomaly checks, completion prompts and the "fund the next milestone"
  // nudge — shared with the auto-release after a top-up.
  await finalizeReleases(project, releasedEscrow ? [releasedEscrow] : [], { justCompleted });

  return ok(res, { project, releasedEscrow, awaitingFunds: Boolean(awaitingFunds), shortfall: shortfall || 0 });
});

const PROCEED_AT_RISK_STATEMENT =
  'I understand this milestone is not fully protected by escrow, that any unfunded amount is not currently secured, and that proceeding does not fund the milestone, release any money, or guarantee payment. I want to proceed at my own financial risk.';

/**
 * "Proceed Without Full Escrow" — the awarded contractor voluntarily opens an
 * under-funded milestone at their own financial risk. This is ONLY an
 * override of the funded-milestone gate: it creates no escrow rows, releases
 * nothing, and guarantees nothing. What was on the table (amounts, who, when)
 * is written to an immutable audit record and the funder is told.
 */
const proceedAtRisk = catchAsync(async (req, res) => {
  const { id, milestoneId } = req.params;
  if (req.body.acknowledged !== true) {
    throw ApiError.badRequest('You must explicitly acknowledge the risk to proceed without full escrow');
  }
  const project = await Project.findById(id);
  if (!project) throw ApiError.notFound('Project not found');
  const party = await assertProjectParty(project, req.user._id);
  if (party.via !== 'contractor') {
    throw ApiError.forbidden('Only the awarded contractor can choose to proceed without full escrow');
  }
  const milestone = project.milestones.id(milestoneId);
  if (!milestone) throw ApiError.notFound('Milestone not found');
  if (['released', 'approved'].includes(milestone.status)) {
    throw ApiError.conflict(`This milestone is already ${milestone.status}`);
  }

  const existing = await MilestoneRiskAcknowledgement.findOne({ milestoneId: milestone._id });
  if (existing) {
    return ok(res, { acknowledgement: existing, funding: await getFundingState(project) });
  }

  const state = await getFundingState(project);
  const m = state.milestones.find((x) => x.id === String(milestone._id));
  if (m.fundingStatus === 'funded') {
    throw ApiError.conflict('This milestone is already fully funded — there is nothing to acknowledge');
  }

  let acknowledgement;
  try {
    acknowledgement = await MilestoneRiskAcknowledgement.create({
      projectId: project._id,
      milestoneId: milestone._id,
      bidId: (await Bid.findOne({ projectId: project._id, status: 'accepted' }).select('_id').lean())?._id || null,
      contractorId: req.user._id,
      milestoneName: milestone.name,
      milestoneAmount: milestone.amount,
      fundedAmount: m.fundedAmount,
      unfundedAmount: m.unfundedAmount,
      currency: project.currency,
      statement: PROCEED_AT_RISK_STATEMENT,
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
    acknowledgement = await MilestoneRiskAcknowledgement.findOne({ milestoneId: milestone._id });
  }

  milestone.riskAcknowledgedAt = acknowledgement.acknowledgedAt;
  await project.save();

  await notificationService.notify(project.ownerId, 'milestone_proceed_at_risk', {
    projectId: project._id,
    milestoneId: milestone._id,
    milestoneName: milestone.name,
    amount: milestone.amount,
    fundedAmount: m.fundedAmount,
    unfundedAmount: m.unfundedAmount,
  });

  return created(res, { acknowledgement, funding: await getFundingState(project) });
});

/** Is this user a real party to this project — the owner (funder on a
 * tender; the project's own owner on a land_purchase project, or a legacy
 * funding project — that project type is retired), its co-signer, or
 * (tender-only) the contractor whose bid was accepted? Shared by
 * disputeMilestone and requestMilestoneChanges — neither previously checked
 * this at all, which let any authenticated stranger dispute or send back a
 * project they had nothing to do with.
 *
 * `{ allowDelegate: true }` (submitEvidence only) additionally lets in a
 * contractor's team member with the 'submit_milestones' permission — see
 * TeamMember.js. Deliberately not honored by dispute/change-request or any
 * other project action, so a delegate's access never silently grows beyond
 * exactly what it was granted for. Returns which path matched so callers
 * that need to tell a delegate's own submission apart from the contractor's
 * (attribution, notifications, audit log) can do so without re-querying. */
async function assertProjectParty(project, userId, { allowDelegate = false } = {}) {
  const uid = String(userId);
  if (String(project.ownerId) === uid) return { via: 'owner' };
  if (project.coSignerId && String(project.coSignerId) === uid) return { via: 'cosigner' };
  let acceptedBid = null;
  if (project.projectType === 'tender') {
    acceptedBid = await Bid.findOne({ projectId: project._id, status: 'accepted' }).select('contractorId').lean();
    if (acceptedBid && String(acceptedBid.contractorId) === uid) return { via: 'contractor' };
  }
  if (allowDelegate && acceptedBid) {
    const isDelegate = await TeamMember.exists({
      ownerId: acceptedBid.contractorId,
      userId,
      status: 'active',
      permissions: 'submit_milestones',
    });
    if (isDelegate) return { via: 'delegate', contractorId: acceptedBid.contractorId };
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
  getFundingQuote,
  fundProject,
  submitEvidence,
  decideApproval,
  proceedAtRisk,
  disputeMilestone,
  requestMilestoneChanges,
  addCoSigner,
  assignSupplier,
  updateLocation,
  updateMilestoneLocation,
  uploadPlanDocument,
  getPlanDocument,
  requestLocationVerification,
  getRecommendedVerifiersForProject,
  getFundingSummaryData,
};
