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

module.exports = model('Escrow', EscrowSchema);
