const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const conversionService = require('../services/conversionService');
const geocodingService = require('../services/geocodingService');

/** Thin public wrapper over conversionService.convertAmount — no new
 * conversion logic, just exposes what's already used internally during
 * releaseMilestoneEscrow so the frontend's currency-converter tool has a
 * real endpoint instead of doing the math itself. No auth: it's a
 * stateless calculator, same framing as the frontend tool screen itself. */
const convert = catchAsync(async (req, res) => {
  const { amount, from, to } = req.query;
  if (!amount || !from || !to) throw ApiError.badRequest('amount, from, and to are required');

  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount < 0) throw ApiError.badRequest('amount must be a non-negative number');

  try {
    const result = await conversionService.convertAmount(numericAmount, from.toUpperCase(), to.toUpperCase());
    return ok(res, result);
  } catch (err) {
    throw ApiError.badRequest(err.message);
  }
});

/** Thin wrapper over geocodingService.reverseGeocode — used by
 * MilestoneSubmitScreen to show a real place name (not raw coordinates)
 * the moment a GPS fix comes in, and the resolved name is then submitted
 * alongside the evidence itself so it's persisted (see
 * projectController.submitEvidence) rather than needing to be re-resolved
 * on every later view. No auth, same framing as convert() above — a
 * stateless lookup, not a write. */
const reverseGeocode = catchAsync(async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw ApiError.badRequest('lat and lng are required numbers');

  const placeName = await geocodingService.reverseGeocode(lat, lng);
  return ok(res, { placeName });
});

module.exports = { convert, reverseGeocode };
