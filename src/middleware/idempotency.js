const { IdempotencyKey } = require('../models');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');

/**
 * Guards a money-moving route against duplicate submission. Callers must
 * send an `Idempotency-Key` header (any client-generated unique string,
 * e.g. a UUID minted once per user action). The first request for a given
 * key executes normally and its response is recorded; any repeat with the
 * same key/user/route replays that recorded response instead of re-running
 * the handler — so a retried "fund project" tap can never create two
 * escrow transactions.
 */
const idempotent = catchAsync(async (req, res, next) => {
  const key = req.headers['idempotency-key'];
  if (!key || typeof key !== 'string') {
    throw ApiError.badRequest('Idempotency-Key header is required for this operation');
  }
  const route = `${req.method} ${req.baseUrl}${req.route ? req.route.path : req.path}`;

  const existing = await IdempotencyKey.findOne({ key, userId: req.user._id, route });
  if (existing) {
    res.setHeader('Idempotency-Replayed', 'true');
    return res.status(existing.responseStatus).json(existing.responseBody);
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    IdempotencyKey.create({
      key,
      userId: req.user._id,
      route,
      responseStatus: res.statusCode,
      responseBody: body,
    }).catch((err) => {
      // A race between two truly-simultaneous identical requests can hit the
      // unique index here; the response has already been sent either way, so
      // just log it rather than failing an already-completed request.
      if (err.code !== 11000) console.error('[idempotency] failed to record key:', err.message);
    });
    return originalJson(body);
  };

  next();
});

module.exports = idempotent;
