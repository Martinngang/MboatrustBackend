const { RiskFlag } = require('../models');
const { buildCrud } = require('./controllerFactory');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

const crud = buildCrud(RiskFlag, { searchableFilters: ['userId', 'severity', 'flagType'] });

const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, userId, severity, flagType } = req.query;
  const filter = {};
  if (userId) filter.userId = userId;
  if (severity) filter.severity = severity;
  if (flagType) filter.flagType = flagType;

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

module.exports = { getAll, getOne: crud.getOne, create: crud.create };
