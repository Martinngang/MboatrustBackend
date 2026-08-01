const { Schema, model } = require('mongoose');

const VerificationTaskSchema = new Schema(
  {
    targetType: { type: String, enum: ['milestone', 'land_listing'], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true }, // polymorphic — Project.milestones._id or LandListing._id
    verifierId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['assigned', 'in_progress', 'submitted'], default: 'assigned' },
    reportText: { type: String, default: '' },
    reportPhotos: { type: [String], default: [] },
    confirmedMatch: { type: Boolean, default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

VerificationTaskSchema.index({ targetType: 1, targetId: 1 });
VerificationTaskSchema.index({ verifierId: 1, status: 1 });

module.exports = model('VerificationTask', VerificationTaskSchema);
