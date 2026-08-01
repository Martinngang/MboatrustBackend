const { Schema, model } = require('mongoose');

const DisputeSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    milestoneId: { type: Schema.Types.ObjectId, default: null },
    raisedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, required: true },
    status: { type: String, enum: ['open', 'under_review', 'resolved', 'rejected'], default: 'open' },
    resolutionNotes: { type: String, default: '' },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

DisputeSchema.index({ projectId: 1 });
DisputeSchema.index({ status: 1 });

module.exports = model('Dispute', DisputeSchema);
