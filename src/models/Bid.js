const { Schema, model } = require('mongoose');

const BidSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    contractorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    price: { type: Number, required: true, min: 0 },
    timelineDays: { type: Number, required: true, min: 1 },
    materialsPlan: { type: String, default: '' },
    notes: { type: String, default: '' },
    status: { type: String, enum: ['submitted', 'accepted', 'rejected', 'withdrawn'], default: 'submitted' },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

BidSchema.index({ projectId: 1, status: 1 });
BidSchema.index({ contractorId: 1 });

module.exports = model('Bid', BidSchema);
