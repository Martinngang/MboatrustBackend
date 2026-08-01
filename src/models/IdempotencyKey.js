const { Schema, model } = require('mongoose');

/**
 * Records the first response for a given (user, route, Idempotency-Key)
 * triple so a retried request (client double-submit, network retry on a
 * flaky connection) replays the original result instead of moving money
 * twice. Entries expire automatically — a duplicate submitted long after
 * the original is treated as a new request.
 */
const IdempotencyKeySchema = new Schema({
  key: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  route: { type: String, required: true },
  responseStatus: { type: Number, required: true },
  responseBody: { type: Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 }, // 24h TTL
});

IdempotencyKeySchema.index({ key: 1, userId: 1, route: 1 }, { unique: true });

module.exports = model('IdempotencyKey', IdempotencyKeySchema);
