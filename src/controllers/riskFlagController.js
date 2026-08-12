const { RiskFlag } = require('../models');
const { buildCrud } = require('./controllerFactory');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

const crud = buildCrud(RiskFlag, { searchableFilters: ['userId', 'severity', 'flagType'] });

const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, userId, severity, flagType, minAiRiskScore } = req.query;
  const filter = {};
  if (userId) filter.userId = userId;
  if (severity) filter.severity = severity;
  if (flagType) filter.flagType = flagType;
  if (minAiRiskScore) filter.aiRiskScore = { $gte: Number(minAiRiskScore) };

  const [items, total] = await Promise.all([
    RiskFlag.find(filter)
      .populate('userId', 'fullName')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    RiskFlag.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getSummary = catchAsync(async (req, res) => {
  const match = {};
  if (req.query.since) match.createdAt = { $gte: new Date(req.query.since) };

  const [byFlagType, bySeverity, aiAgg] = await Promise.all([
    RiskFlag.aggregate([{ $match: match }, { $group: { _id: '$flagType', count: { $sum: 1 } } }]),
    RiskFlag.aggregate([{ $match: match }, { $group: { _id: '$severity', count: { $sum: 1 } } }]),
    RiskFlag.aggregate([
      { $match: { ...match, aiRiskScore: { $ne: null } } },
      { $group: { _id: null, avgAiRiskScore: { $avg: '$aiRiskScore' }, aiFlaggedCount: { $sum: 1 } } },
    ]),
  ]);

  const countByFlagType = Object.fromEntries(byFlagType.map((r) => [r._id, r.count]));
  const countBySeverity = Object.fromEntries(bySeverity.map((r) => [r._id, r.count]));

  return ok(res, {
    countByFlagType,
    countBySeverity,
    avgAiRiskScore: aiAgg[0]?.avgAiRiskScore ?? null,
    aiFlaggedCount: aiAgg[0]?.aiFlaggedCount || 0,
  });
});

module.exports = { getAll, getSummary, getOne: crud.getOne, create: crud.create };
