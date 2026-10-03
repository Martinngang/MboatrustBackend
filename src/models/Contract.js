const { Schema, model } = require('mongoose');

// Snapshot of the milestone payment schedule agreed at acceptance — the
// live Project.milestones keep changing status, this is the record of what
// was actually agreed.
const AgreedMilestoneSchema = new Schema(
  {
    name: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    orderIndex: { type: Number, required: true },
  },
  { _id: false }
);

const ContractSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    bidId: { type: Schema.Types.ObjectId, ref: 'Bid', required: true },
    // Agreed terms at acceptance time (total contract value and how escrow
    // gets funded) — previously the only record of these was the bid's
    // negotiation rounds plus free text below.
    totalAmount: { type: Number, default: null },
    fundingMode: { type: String, enum: ['staged', 'full_upfront'], default: 'staged' },
    milestoneSchedule: { type: [AgreedMilestoneSchema], default: [] },
    generatedDocumentUrl: { type: String, default: null },
    // Plain-text contract terms generated at acceptance time — a real PDF
    // render + Cloudinary upload (populating generatedDocumentUrl) is a
    // follow-up once storage credentials are configured; this keeps the
    // "digital contract" concept genuinely backed by real bid/project data
    // in the meantime rather than left entirely unimplemented.
    generatedDocumentText: { type: String, default: null },
    status: { type: String, enum: ['active', 'completed', 'terminated'], default: 'active' },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

ContractSchema.index({ projectId: 1 });

module.exports = model('Contract', ContractSchema);
