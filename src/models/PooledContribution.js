const { Schema, model } = require('mongoose');

/** One funder's pledge toward a project — either a one-off top-up alongside
 * the project's main funding, or the first (and every subsequent) charge of
 * a recurring pledge. Each successful charge creates a real Escrow document
 * through the exact same collection path as a normal single-funder deposit
 * (see projectController.fundProject) — this model tracks the pledge itself,
 * not a second money-movement system. */
const PooledContributionSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    contributorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'XAF' },
    isRecurring: { type: Boolean, default: false },
    recurrenceIntervalDays: { type: Number, default: null },
    // Stored from the first successful charge so a recurring contribution
    // can actually be re-charged automatically — MTN MoMo collection needs a
    // real MSISDN on every request, it can't be re-authorized once and
    // reused implicitly the way a card token would be.
    payerPhoneNumber: { type: String, default: null },
    nextChargeAt: { type: Date, default: null },
    // Distinct from cancelling: a paused recurring pledge keeps its
    // schedule/history and can resume, skipped by the charge cron in the
    // meantime rather than stopped for good (isRecurring: false).
    paused: { type: Boolean, default: false },
    status: { type: String, enum: ['pending', 'collected', 'failed', 'cancelled'], default: 'pending' },
    escrowId: { type: Schema.Types.ObjectId, ref: 'Escrow', default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

PooledContributionSchema.index({ projectId: 1 });
PooledContributionSchema.index({ isRecurring: 1, status: 1, nextChargeAt: 1 });

module.exports = model('PooledContribution', PooledContributionSchema);
