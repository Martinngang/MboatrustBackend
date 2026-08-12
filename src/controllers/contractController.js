const { Contract, Project, Bid } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const notificationService = require('../services/notificationService');
const referralService = require('../services/referralService');

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

/** A signed contract's generated text is private between its two real
 * parties — Contract has no direct owner/contractor field (only
 * projectId/bidId), so scoping means first resolving which projects the
 * caller owns and which bids they placed, the same join assertParty uses
 * for the write-side actions below. Previously this had no scoping at all
 * (buildCrud's generic getAll/getOne), letting any authenticated user read
 * every contract on the platform. */
const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, projectId, bidId, status } = req.query;
  const filter = {};
  if (projectId) filter.projectId = projectId;
  if (bidId) filter.bidId = bidId;
  if (status) filter.status = status;

  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  if (!isAdmin) {
    const [myProjects, myBids] = await Promise.all([
      Project.find({ ownerId: req.user._id }).select('_id').lean(),
      Bid.find({ contractorId: req.user._id }).select('_id').lean(),
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
  return ok(res, contract);
});

module.exports = { getAll, getOne, markCompleted, terminate };
