const mongoose = require('mongoose');
const { ContractorProfile, Bid, Rating, Escrow, User } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

const EMPTY_PROFILE = {
  categories: [],
  regions: [],
  location: { lat: null, lng: null },
  bio: '',
  yearsExperience: 0,
  isAvailable: true,
};

/** Live stats — never denormalized onto ContractorProfile, always computed
 * fresh from Bid/Project/Rating so they can't drift out of sync. Every
 * ratio is guarded against a zero denominator (returns 0, never NaN/Infinity). */
async function getStats(userId) {
  const contractorId = new mongoose.Types.ObjectId(userId);

  const [bidCounts, completionAgg, ratingAgg] = await Promise.all([
    Bid.aggregate([
      { $match: { contractorId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Bid.aggregate([
      { $match: { contractorId, status: 'accepted' } },
      {
        $lookup: {
          from: 'projects',
          localField: 'projectId',
          foreignField: '_id',
          as: 'project',
        },
      },
      { $unwind: '$project' },
      {
        $group: {
          _id: null,
          accepted: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$project.status', 'completed'] }, 1, 0] } },
        },
      },
    ]),
    Rating.aggregate([
      { $match: { toUserId: contractorId, roleContext: 'contractor' } },
      { $group: { _id: null, average: { $avg: '$score' }, count: { $sum: 1 } } },
    ]),
  ]);

  const totalBids = bidCounts.reduce((sum, b) => sum + b.count, 0);
  const acceptedBids = bidCounts.find((b) => b._id === 'accepted')?.count || 0;
  const completedProjects = completionAgg[0]?.completed || 0;
  const completionRate = acceptedBids > 0 ? completedProjects / acceptedBids : 0;
  const avgRating = ratingAgg[0]?.average ?? null;
  const ratingCount = ratingAgg[0]?.count || 0;

  return { completedProjects, totalBids, acceptedBids, completionRate, avgRating, ratingCount };
}

/** Public marketplace directory — every User with the contractor role, left-
 * joined with their ContractorProfile (a contractor who hasn't filled theirs
 * in yet still shows up, same EMPTY_PROFILE fallback getMine/getPublic use)
 * plus the same live-computed stats. When filtering by category/region/
 * isAvailable, the ContractorProfile match happens *before* pagination — the
 * opposite order would silently return short/empty pages once a filter
 * excludes any user in the current page's slice. */
const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, category, region, isAvailable } = req.query;
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
      const profile = profileByUser.get(String(u._id)) || { userId: u._id, ...EMPTY_PROFILE };
      const stats = await getStats(u._id);
      return { ...profile, userId: u._id, fullName: u.fullName, avatarUrl: u.avatarUrl, kycStatus: u.kycStatus, stats };
    })
  );
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getMine = catchAsync(async (req, res) => {
  const profile = await ContractorProfile.findOne({ userId: req.user._id }).lean();
  return ok(res, profile || { userId: req.user._id, ...EMPTY_PROFILE });
});

const upsertMine = catchAsync(async (req, res) => {
  const isContractor = req.user.roles?.some((r) => r.roleType === 'contractor');
  if (!isContractor) throw ApiError.forbidden('Requires role: contractor');

  const profile = await ContractorProfile.findOneAndUpdate(
    { userId: req.user._id },
    { $set: req.body },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );
  return ok(res, profile);
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
  const [profile, stats] = await Promise.all([
    ContractorProfile.findOne({ userId: req.params.userId }).lean(),
    getStats(req.params.userId),
  ]);
  return ok(res, { ...(profile || { userId: req.params.userId, ...EMPTY_PROFILE }), stats });
});

module.exports = { getAll, getMine, upsertMine, getPublic, getStats, getEarnings, setAvailability };
