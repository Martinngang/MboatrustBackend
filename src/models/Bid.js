const { Schema, model } = require('mongoose');

const MilestoneProposalSchema = new Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: '' },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const NegotiationRoundSchema = new Schema(
  {
    proposedBy: { type: String, enum: ['funder', 'contractor'], required: true },
    price: { type: Number, required: true, min: 0 },
    timelineDays: { type: Number, required: true, min: 1 },
    milestones: { type: [MilestoneProposalSchema], default: [] },
    message: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const BidSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    contractorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // These three always mirror rounds[rounds.length - 1] — every existing
    // reader (contractorMatchingService's scoring, the bids-with-scores
    // table, notifications) keeps reading "the current terms" here without
    // needing to know a negotiation concept exists at all.
    price: { type: Number, required: true, min: 0 },
    timelineDays: { type: Number, required: true, min: 1 },
    // Optional per-milestone breakdown of `price` — empty means a lump-sum
    // quote with no schedule proposed yet.
    milestones: { type: [MilestoneProposalSchema], default: [] },
    materialsPlan: { type: String, default: '' },
    notes: { type: String, default: '' },
    status: { type: String, enum: ['submitted', 'accepted', 'rejected', 'withdrawn'], default: 'submitted' },
    // Full negotiation history, newest last — seeded with one entry the
    // moment the bid is created (see bidController.create) and appended to
    // by bidController.counter. 'submitted' spans the whole negotiation, not
    // just the first offer; this plus lastProposedBy is how the frontend
    // knows whose turn it is without re-deriving it from the array.
    rounds: { type: [NegotiationRoundSchema], default: [] },
    lastProposedBy: { type: String, enum: ['funder', 'contractor'], default: 'contractor' },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

BidSchema.index({ projectId: 1, status: 1 });
BidSchema.index({ contractorId: 1 });
// One bid per contractor per tender, ever — not just while a bid is active.
// Once a contractor has bid, they don't get a second attempt even if this
// one is later rejected/withdrawn (see bidController.create's explicit
// pre-check, which gives the friendlier conflict message; this is the
// hard backend guarantee for the race between two simultaneous submits).
BidSchema.index({ projectId: 1, contractorId: 1 }, { unique: true });

module.exports = model('Bid', BidSchema);
