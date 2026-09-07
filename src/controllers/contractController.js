const { Contract, Project, Bid, TeamMember } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const notificationService = require('../services/notificationService');
const referralService = require('../services/referralService');
const { logAdminAction } = require('../services/adminActionLogService');

/** A contract's only two real parties: the project owner (funder) and the
 * bid's contractor — resolved fresh from Project/Bid rather than stored
 * redundantly on Contract, since those are the sources of truth. */
async function assertParty(contract, user) {
  const isAdmin = user.roles?.some((r) => r.roleType === 'admin');
  if (isAdmin) return;
  const [project, bid] = await Promise.all([
    Project.findById(contract.projectId).select('ownerId').lean(),
    Bid.findById(contract.bidId).select('contractorId').lean(),
  ]);
  const isFunder = project && String(project.ownerId) === String(user._id);
  const isContractor = bid && String(bid.contractorId) === String(user._id);
  if (!isFunder && !isContractor) {
    throw ApiError.forbidden('Only this contract\'s funder, its contractor, or an admin can change it');
  }
}

/** Contractor ids of every contractor `userId` is an active
 * 'submit_milestones' team delegate for — see the identical helper in
 * bidController.js, which this mirrors so a delegate's contract visibility
 * matches their bid visibility exactly. */
async function myDelegatedForIds(userId) {
  const rows = await TeamMember.find({ userId, status: 'active', permissions: 'submit_milestones' }).select('ownerId').lean();
  return rows.map((r) => r.ownerId);
}

/** A signed contract's generated text is private between its two real
 * parties — Contract has no direct owner/contractor field (only
 * projectId/bidId), so scoping means first resolving which projects the
 * caller owns and which bids they placed, the same join assertParty uses
 * for the write-side actions below. Previously this had no scoping at all
 * (buildCrud's generic getAll/getOne), letting any authenticated user read
 * every contract on the platform. */
const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, projectId, bidId, status, contractorId } = req.query;
  const filter = {};
  if (projectId) filter.projectId = projectId;
  if (bidId) filter.bidId = bidId;
  if (status) filter.status = status;
  // Contract has no direct contractor field (only bidId) — same
  // resolve-via-Bid join assertParty uses, exposed as a filter for the
  // admin contractor-detail view. Expanded to include delegated-for
  // contractors only when the caller is asking for their own id (the shape
  // ContractDetailScreen actually sends) — see bidController.getAll's
  // identical comment.
  let delegatedForIds = [];
  if (contractorId) {
    let contractorIds = [contractorId];
    if (String(contractorId) === String(req.user._id)) {
      delegatedForIds = await myDelegatedForIds(req.user._id);
      contractorIds = [contractorId, ...delegatedForIds];
    }
    const theirBids = await Bid.find({ contractorId: { $in: contractorIds } }).select('_id').lean();
    filter.bidId = { $in: theirBids.map((b) => b._id) };
  }

  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  if (!isAdmin) {
    if (delegatedForIds.length === 0) delegatedForIds = await myDelegatedForIds(req.user._id);
    const [myProjects, myBids] = await Promise.all([
      Project.find({ ownerId: req.user._id }).select('_id').lean(),
      Bid.find({ contractorId: { $in: [req.user._id, ...delegatedForIds] } }).select('_id').lean(),
    ]);
    filter.$or = [
      { projectId: { $in: myProjects.map((p) => p._id) } },
      { bidId: { $in: myBids.map((b) => b._id) } },
    ];
  }

  const [items, total] = await Promise.all([
    Contract.find(filter).populate('projectId', 'title totalAmount').sort('-createdAt').skip((page - 1) * limit).limit(Number(limit)),
    Contract.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getOne = catchAsync(async (req, res) => {
  const contract = await Contract.findById(req.params.id).populate('projectId', 'title totalAmount description');
  if (!contract) throw ApiError.notFound('Contract not found');
  await assertParty(contract, req.user);
  return ok(res, contract);
});

const markCompleted = catchAsync(async (req, res) => {
  const contract = await Contract.findById(req.params.id);
  if (!contract) throw ApiError.notFound('Contract not found');
  if (contract.status !== 'active') throw ApiError.conflict(`Only an active contract can be completed (currently "${contract.status}")`);
  await assertParty(contract, req.user);

  contract.status = 'completed';
  await contract.save();

  // Same rating-prompt + referral-reward trigger as a funding project
  // reaching 'completed' (projectController.decideApproval) — this is the
  // tender-pillar's equivalent completion event.
  const [project, bid] = await Promise.all([
    Project.findById(contract.projectId).select('ownerId').lean(),
    Bid.findById(contract.bidId).select('contractorId').lean(),
  ]);
  if (project && bid) {
    await notificationService.notify(project.ownerId, 'rating_prompt', { projectId: contract.projectId });
    await notificationService.notify(bid.contractorId, 'rating_prompt', { projectId: contract.projectId });
    await referralService.maybeRewardReferral(project.ownerId);
    await referralService.maybeRewardReferral(bid.contractorId);
  }

  return ok(res, contract);
});

const terminate = catchAsync(async (req, res) => {
  const contract = await Contract.findById(req.params.id);
  if (!contract) throw ApiError.notFound('Contract not found');
  if (contract.status !== 'active') throw ApiError.conflict(`Only an active contract can be terminated (currently "${contract.status}")`);
  await assertParty(contract, req.user);

  contract.status = 'terminated';
  await contract.save();

  // Both real parties should know, same as markCompleted's rating_prompt
  // fan-out above — admin attribution on the EmailLog only when the actor
  // genuinely is an admin (this route is also reachable by either party).
  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  const meta = isAdmin
    ? { adminId: req.user._id, relatedAction: 'contract.terminate', relatedType: 'Contract', relatedId: contract._id }
    : {};
  const [project, bid] = await Promise.all([
    Project.findById(contract.projectId).select('ownerId title').lean(),
    Bid.findById(contract.bidId).select('contractorId').lean(),
  ]);
  if (project) await notificationService.notify(project.ownerId, 'contract_terminated', { projectTitle: project.title }, meta);
  if (bid) await notificationService.notify(bid.contractorId, 'contract_terminated', { projectTitle: project?.title }, meta);

  return ok(res, contract);
});

/** Admin-only — contracts are normally system-generated when a bid is
 * accepted; this exists for correcting/backfilling a real hire that
 * predates that flow or was recorded elsewhere. */
const adminCreate = catchAsync(async (req, res) => {
  const { projectId, bidId } = req.body;
  const [project, bid] = await Promise.all([
    Project.findById(projectId).select('_id').lean(),
    Bid.findById(bidId).select('projectId').lean(),
  ]);
  if (!project) throw ApiError.badRequest('No such project');
  if (!bid) throw ApiError.badRequest('No such bid');
  if (String(bid.projectId) !== String(projectId)) throw ApiError.badRequest('That bid was not placed on this project');

  const contract = await Contract.create(req.body);
  await logAdminAction({ adminId: req.user._id, action: 'contract.create', targetType: 'Contract', targetId: contract._id, detail: { projectId, bidId } });
  return created(res, contract);
});

/** Notifies both real parties of an admin edit/removal — resolved fresh via
 * the contract's projectId/bidId, same join assertParty uses, since Contract
 * itself carries no direct owner/contractor field. */
async function notifyContractParties(contract, type, adminId, relatedAction) {
  const [project, bid] = await Promise.all([
    Project.findById(contract.projectId).select('ownerId').lean(),
    Bid.findById(contract.bidId).select('contractorId').lean(),
  ]);
  const meta = { adminId, relatedAction, relatedType: 'Contract', relatedId: contract._id };
  if (project) await notificationService.notify(project.ownerId, type, {}, meta);
  if (bid) await notificationService.notify(bid.contractorId, type, {}, meta);
}

const adminUpdate = catchAsync(async (req, res) => {
  const contract = await Contract.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!contract) throw ApiError.notFound('Contract not found');
  await logAdminAction({ adminId: req.user._id, action: 'contract.update', targetType: 'Contract', targetId: contract._id, detail: { fields: Object.keys(req.body) } });
  await notifyContractParties(contract, 'contract_edited_or_removed_by_admin', req.user._id, 'contract.update');
  return ok(res, contract);
});

const adminRemove = catchAsync(async (req, res) => {
  const contract = await Contract.findByIdAndDelete(req.params.id);
  if (!contract) throw ApiError.notFound('Contract not found');
  await logAdminAction({ adminId: req.user._id, action: 'contract.remove', targetType: 'Contract', targetId: req.params.id, detail: { projectId: contract.projectId } });
  await notifyContractParties(contract, 'contract_edited_or_removed_by_admin', req.user._id, 'contract.remove');
  return res.status(204).send();
});

module.exports = { getAll, getOne, markCompleted, terminate, adminCreate, adminUpdate, adminRemove };
