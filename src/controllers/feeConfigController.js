const { FeeConfig } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

// Public read — every fee preview in the UI reads from this collection.
const getAll = catchAsync(async (req, res) => {
  const configs = await FeeConfig.find().sort('feeType');
  return ok(res, configs);
});

const getByType = catchAsync(async (req, res) => {
  const config = await FeeConfig.findOne({ feeType: req.params.feeType });
  if (!config) throw ApiError.notFound('Fee config not found');
  return ok(res, config);
});

// Admin-only write — single source of truth for all fee %/flat values.
const upsert = catchAsync(async (req, res) => {
  const { feeType, value, isFlat } = req.body;
  const config = await FeeConfig.findOneAndUpdate(
    { feeType },
    { value, isFlat, updatedBy: req.user._id },
    { new: true, upsert: true, runValidators: true }
  );
  return ok(res, config);
});

module.exports = { getAll, getByType, upsert };
