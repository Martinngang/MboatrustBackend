const { ContractorProfile, Bid, User, Escrow, Contract } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { logAdminAction } = require('../services/adminActionLogService');
const notificationService = require('../services/notificationService');
const storageService = require('../services/storageService');
const { getStats } = require('../services/contractorStatsService');
const { getLeaderboard: computeLeaderboard } = require('../services/contractorLeaderboardService');

const EMPTY_PROFILE = {
  categories: [],
  regions: [],
  location: { lat: null, lng: null },
  bio: '',
  headline: '',
  services: [],
  portfolioImages: [],
  yearsExperience: 0,
  isAvailable: true,
};

/** Backfills any field a document is missing (via .lean(), or via a $set
 * update that never touched a field a schema addition introduced *after*
 * that document was created — Mongoose's schema defaults only apply on
 * document construction, never retroactively on read or on an update that
 * doesn't mention the field) with EMPTY_PROFILE's default, without
 * clobbering any real value the document does have. Every place this
 * controller hands a profile object to the frontend goes through this —
 * skipping it for even one is exactly how ContractorProfileScreen's edit
 * form crashed on `services.length` for every contractor profile created
 * before `services`/`headline`/`portfolioImages` existed on the schema. */
function withDefaults(profile) {
  return { ...EMPTY_PROFILE, ...(profile || {}) };
}

/** Public marketplace directory — every User with the contractor role, left-
 * joined with their ContractorProfile (a contractor who hasn't filled theirs
 * in yet still shows up, same EMPTY_PROFILE fallback getMine/getPublic use)
 * plus the same live-computed stats. When filtering by category/region/
 * isAvailable, the ContractorProfile match happens *before* pagination — the
 * opposite order would silently return short/empty pages once a filter
 * excludes any user in the current page's slice. */
const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, category, region, isAvailable, search } = req.query;
  const filtering = Boolean(category || region || isAvailable !== undefined);

  const userFilter = { 'roles.roleType': 'contractor' };
  if (filtering) {
    const profileFilter = {};
    if (category) profileFilter.categories = category;
    if (region) profileFilter.regions = region;
    if (isAvailable !== undefined) profileFilter.isAvailable = isAvailable === 'true';
    const matching = await ContractorProfile.find(profileFilter).select('userId').lean();
    userFilter._id = { $in: matching.map((p) => p.userId) };
  }
  if (search) {
    const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    userFilter.fullName = new RegExp(escaped, 'i');
  }

  const [users, total] = await Promise.all([
    User.find(userFilter)
      .select('fullName avatarUrl kycStatus')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    User.countDocuments(userFilter),
  ]);

  const profiles = await ContractorProfile.find({ userId: { $in: users.map((u) => u._id) } }).lean();
  const profileByUser = new Map(profiles.map((p) => [String(p.userId), p]));

  const items = await Promise.all(
    users.map(async (u) => {
      const profile = withDefaults(profileByUser.get(String(u._id)));
      const stats = await getStats(u._id);
      return { ...profile, userId: u._id, fullName: u.fullName, avatarUrl: u.avatarUrl, kycStatus: u.kycStatus, stats };
    })
  );
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getMine = catchAsync(async (req, res) => {
  const profile = await ContractorProfile.findOne({ userId: req.user._id }).lean();
  return ok(res, { ...withDefaults(profile), userId: req.user._id });
});

const upsertMine = catchAsync(async (req, res) => {
  const isContractor = req.user.roles?.some((r) => r.roleType === 'contractor');
  if (!isContractor) throw ApiError.forbidden('Requires role: contractor');

  const { existingPortfolioImages, ...rest } = req.body;
  const uploaded = req.files?.length
    ? await Promise.all(req.files.map((f) => storageService.uploadBuffer(f.buffer, { folder: `mboatrust/contractor-portfolio/${req.user._id}` })))
    : [];
  const update = { ...rest };
  if (existingPortfolioImages !== undefined || uploaded.length > 0) {
    update.portfolioImages = [
      ...(existingPortfolioImages ?? []),
      ...uploaded.map((u) => ({ url: u.secure_url, caption: '' })),
    ];
  }

  const profile = await ContractorProfile.findOneAndUpdate(
    { userId: req.user._id },
    { $set: update },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );
  // $set only ever touches the fields this call actually sent — a profile
  // created before headline/services/portfolioImages existed on the schema
  // and never since edited through all three would still lack them here.
  return ok(res, withDefaults(profile.toObject()));
});

const getEarnings = catchAsync(async (req, res) => {
  const contractorId = req.user._id;

  const [totals, byMonth] = await Promise.all([
    Escrow.aggregate([
      { $match: { contractorId, type: 'release' } },
      {
        $group: {
          _id: '$status',
          amount: { $sum: '$netAmount' },
        },
      },
    ]),
    Escrow.aggregate([
      { $match: { contractorId, type: 'release', status: 'completed' } },
      {
        $group: {
          _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
          amount: { $sum: '$netAmount' },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]),
  ]);

  const totalEarned = totals.find((t) => t._id === 'completed')?.amount || 0;
  const totalPending = totals.find((t) => t._id === 'pending')?.amount || 0;

  return ok(res, {
    totalEarned,
    totalPending,
    byMonth: byMonth.map((m) => ({ year: m._id.year, month: m._id.month, amount: m.amount })),
  });
});

/** Replaces (upserts) availability entries for the given dates in one call —
 * a date already present gets its isAvailable overwritten, a new date gets
 * appended, everything else on the calendar is left untouched. */
const setAvailability = catchAsync(async (req, res) => {
  const isContractor = req.user.roles?.some((r) => r.roleType === 'contractor');
  if (!isContractor) throw ApiError.forbidden('Requires role: contractor');

  const { dates } = req.body; // [{ date, isAvailable }]
  const profile = await ContractorProfile.findOneAndUpdate(
    { userId: req.user._id },
    { $setOnInsert: { userId: req.user._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  for (const entry of dates) {
    const day = new Date(entry.date);
    const existing = profile.availability.find((a) => a.date.toISOString().slice(0, 10) === day.toISOString().slice(0, 10));
    if (existing) existing.isAvailable = entry.isAvailable;
    else profile.availability.push({ date: day, isAvailable: entry.isAvailable });
  }
  await profile.save();
  return ok(res, profile);
});

const getPublic = catchAsync(async (req, res) => {
  const [user, profile, stats] = await Promise.all([
    User.findById(req.params.userId).select('fullName avatarUrl kycStatus').lean(),
    ContractorProfile.findOne({ userId: req.params.userId }).lean(),
    getStats(req.params.userId),
  ]);
  if (!user) throw ApiError.notFound('Contractor not found');
  return ok(res, {
    ...withDefaults(profile),
    userId: req.params.userId,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl,
    kycStatus: user.kycStatus,
    stats,
  });
});

/** Real platform work only — resolved live via Bid→Contract (Contract has no
 * direct contractorId field), never denormalized onto ContractorProfile,
 * same "always computed fresh" rule getStats follows. Deliberately public-
 * safe: only what a funder evaluating this contractor should see (project
 * title/category/region, when it wrapped up) — never the contract's
 * generatedDocumentText or totalAmount, which contractController.getAll's
 * own party-only scoping keeps private between the two real parties. */
const getCompletedWork = catchAsync(async (req, res) => {
  const bids = await Bid.find({ contractorId: req.params.userId, status: 'accepted' }).select('_id').lean();
  const contracts = await Contract.find({ bidId: { $in: bids.map((b) => b._id) }, status: 'completed' })
    .populate('projectId', 'title category locationName')
    .sort('-updatedAt')
    .limit(20)
    .lean();

  const items = contracts
    .filter((c) => c.projectId)
    .map((c) => ({
      id: c._id,
      projectTitle: c.projectId.title,
      category: c.projectId.category,
      location: c.projectId.locationName,
      completedAt: c.updatedAt,
    }));
  return ok(res, items);
});

/** Public ranking — every contractor role-holder, scored and sorted by the
 * same "weighted 0-100, auditable breakdown" convention
 * contractorMatchingService uses for per-tender matching. Unlike that
 * service, this has no project to match against, so the dimensions are the
 * project-independent metrics the leaderboard was actually asked for:
 * completed projects, ratings, reliability, and verified experience. See
 * services/contractorLeaderboardService.js. */
const getLeaderboard = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, search, category, region, verified } = req.query;
  const result = await computeLeaderboard({
    search, category, region,
    verified: verified === undefined ? undefined : verified === 'true',
    page: Number(page), limit: Number(limit),
  });
  return ok(res, result.items, { page: Number(page), limit: Number(limit), total: result.total });
});

/** Admin-only edit of any contractor's profile — same upsert shape as
 * upsertMine, parametrized by req.params.userId instead of req.user._id,
 * skipping the self-service isContractor check (an admin can correct a
 * profile regardless of the target's current role state). */
const adminUpsert = catchAsync(async (req, res) => {
  const profile = await ContractorProfile.findOneAndUpdate(
    { userId: req.params.userId },
    { $set: req.body, $setOnInsert: { userId: req.params.userId } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );
  await logAdminAction({ adminId: req.user._id, action: 'contractorProfile.adminUpdate', targetType: 'ContractorProfile', targetId: profile._id, detail: { userId: req.params.userId, fields: Object.keys(req.body) } });
  await notificationService.notify(
    req.params.userId,
    'contractor_profile_edited_by_admin',
    {},
    { adminId: req.user._id, relatedAction: 'contractorProfile.adminUpdate', relatedType: 'ContractorProfile', relatedId: profile._id }
  );
  return ok(res, withDefaults(profile.toObject()));
});

module.exports = { getAll, getMine, upsertMine, adminUpsert, getPublic, getStats, getEarnings, setAvailability, getCompletedWork, getLeaderboard };
