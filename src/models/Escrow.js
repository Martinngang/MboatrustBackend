const { Schema, model } = require('mongoose');

const FeeBreakdownSchema = new Schema(
  {
    feeType: { type: String, default: null },
    feeRate: { type: Number, default: 0 },
    feeAmount: { type: Number, default: 0 },
  },
  { _id: false }
);

const CurrencyConversionSchema = new Schema(
  {
    fromCurrency: { type: String, default: null },
    toCurrency: { type: String, default: null },
    rate: { type: Number, default: null },
    amountBeforeConversion: { type: Number, default: null },
    convertedAmount: { type: Number, default: null },
    conversionFee: { type: Number, default: null },
  },
  { _id: false }
);

const EscrowSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    milestoneId: { type: Schema.Types.ObjectId, default: null }, // subdocument _id within Project.milestones
    // Set only on a 'refund' escrow, pointing back at the specific 'fund'
    // escrow it reverses — a project can have several fund transactions
    // (pooled contributions), each refundable independently, so uniqueness
    // has to be scoped to "this one fund transaction", not the project or
    // milestone (see the partial index below).
    originalEscrowId: { type: Schema.Types.ObjectId, ref: 'Escrow', default: null },
    // Set only on a tender project's release escrow, from that project's
    // accepted Bid — null for funding/land_purchase escrows, which have no
    // contractor party at all.
    contractorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    type: { type: String, enum: ['fund', 'release', 'refund', 'fee_deduction'], required: true },
    grossAmount: { type: Number, required: true, min: 0 },
    feeBreakdown: { type: FeeBreakdownSchema, default: () => ({}) },
    netAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'XAF' },
    paymentProvider: { type: String, enum: ['mtn_momo', 'orange_money', 'flutterwave', 'stripe'], required: true },
    providerRole: { type: String, enum: ['collection', 'disbursement'], required: true },
    providerReference: { type: String, default: null },
    currencyConversion: { type: CurrencyConversionSchema, default: null },
    status: { type: String, enum: ['pending', 'completed', 'failed', 'reversed'], default: 'pending' },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

EscrowSchema.index({ projectId: 1, createdAt: -1 });
EscrowSchema.index({ status: 1 });
// Guards against two concurrent milestone-decision requests each releasing
// their own escrow for the same milestone — a real double-payout risk,
// since the project document's optimistic-concurrency check only protects
// the later project.save(), not this independent Escrow.create() write.
// Scoped to type "release" only: multiple "fund" escrows legitimately share
// a milestoneId of null (pooled contributions), so a blanket unique index
// here would incorrectly reject those.
EscrowSchema.index({ milestoneId: 1, type: 1 }, { unique: true, partialFilterExpression: { type: 'release' } });
// Same double-spend guard for refunds — a fund transaction can only ever be
// reversed once, no matter how many concurrent /refund requests target it.
EscrowSchema.index({ originalEscrowId: 1, type: 1 }, { unique: true, partialFilterExpression: { type: 'refund' } });

module.exports = model('Escrow', EscrowSchema);
