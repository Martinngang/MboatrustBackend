const { Schema, model } = require('mongoose');

/** Immutable audit record of a contractor choosing "Proceed Without Full
 * Escrow" on a milestone that wasn't fully funded. It records exactly what
 * was on the table at that moment — it is NOT funding, a release, or a
 * payment guarantee, and never touches the Escrow ledger. Written only by
 * projectController.proceedAtRisk. */
const MilestoneRiskAcknowledgementSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    milestoneId: { type: Schema.Types.ObjectId, required: true },
    bidId: { type: Schema.Types.ObjectId, ref: 'Bid', default: null },
    contractorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    milestoneName: { type: String, default: '' },
    milestoneAmount: { type: Number, required: true },
    fundedAmount: { type: Number, required: true },
    unfundedAmount: { type: Number, required: true },
    currency: { type: String, default: 'XAF' },
    statement: { type: String, required: true },
    acknowledgedAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

MilestoneRiskAcknowledgementSchema.index({ milestoneId: 1 }, { unique: true });
MilestoneRiskAcknowledgementSchema.index({ projectId: 1, acknowledgedAt: -1 });
MilestoneRiskAcknowledgementSchema.index({ contractorId: 1, acknowledgedAt: -1 });

module.exports = model('MilestoneRiskAcknowledgement', MilestoneRiskAcknowledgementSchema);
