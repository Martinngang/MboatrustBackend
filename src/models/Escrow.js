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
    // Set only on a 'fund' escrow, from the authenticated caller of POST
    // /projects/:id/fund — the one place a funder's identity is captured
    // anywhere in this collection. Without it there is no way to answer
    // "which projects has this funder actually funded", at the database
    // level or otherwise (see projectController.getAll's `funderId` filter,
    // which reads this field).
    funderId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    // Set only on a 'release' escrow — who this specific payout actually
    // goes to. 'quincaillerie' only when a real MaterialOrder for this
    // milestone was confirmed/dispatched/delivered by the time of release
    // (see projectController.releaseMilestoneEscrow); otherwise the
    // project's usual payee ('contractor' for a tender, 'recipient'
    // otherwise). Null on every non-release escrow type, which has no
    // single payee concept.
    payeeType: { type: String, enum: ['recipient', 'contractor', 'quincaillerie'], default: null },
    // Set only alongside payeeType 'quincaillerie' — the specific store the
    // release's paymentProvider/payeePhoneNumber were resolved from.
    payeeQuincaillerieId: { type: Schema.Types.ObjectId, ref: 'QuincaillerieProfile', default: null },
    type: { type: String, enum: ['fund', 'release', 'refund', 'fee_deduction'], required: true },
    grossAmount: { type: Number, required: true, min: 0 },
    feeBreakdown: { type: FeeBreakdownSchema, default: () => ({}) },
    netAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'XAF' },
    paymentProvider: { type: String, enum: ['mtn_momo', 'orange_money', 'flutterwave', 'stripe'], required: true },
    providerRole: { type: String, enum: ['collection', 'disbursement'], required: true },
    providerReference: { type: String, default: null },
    // ── Audit trail fields ──
    payerEmail: { type: String, default: null },
    payeePhoneNumber: { type: String, default: null },
    payoutMethodId: { type: Schema.Types.ObjectId, default: null },
    statusHistory: {
      type: [{
        status: String,
        changedAt: { type: Date, default: Date.now },
        detail: { type: String, default: '' },
        _id: false,
      }],
      default: [],
    },
    currencyConversion: { type: CurrencyConversionSchema, default: null },
    status: { type: String, enum: ['pending', 'completed', 'failed', 'reversed'], default: 'pending' },
    // Set only on a 'release' escrow once the payee has confirmed/claimed it
    // in the Withdraw Funds screen — the disbursement itself already moved
    // real money to their MoMo/Orange Money account at release time (see
    // projectController.releaseMilestoneEscrow), so this never triggers a
    // second payment; it just stops an already-claimed release from
    // perpetually showing up as "available to withdraw".
    withdrawnAt: { type: Date, default: null },
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
