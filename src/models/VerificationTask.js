const { Schema, model } = require('mongoose');
const { LocationDetailsSchema } = require('./Project');

const VerificationTaskSchema = new Schema(
  {
    // 'project_location' — targetId is the Project itself (not a milestone
    // subdocument) — a funder who doesn't know the exact site coordinates
    // requests a verifier to go confirm them. See projectController.js's
    // requestLocationVerification.
    targetType: { type: String, enum: ['milestone', 'land_listing', 'project_location'], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true }, // polymorphic — Project.milestones._id, LandListing._id, or Project._id
    verifierId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['assigned', 'in_progress', 'submitted'], default: 'assigned' },
    reportText: { type: String, default: '' },
    reportPhotos: { type: [String], default: [] },
    confirmedMatch: { type: Boolean, default: null },
    // Only meaningful for 'project_location' tasks — where the verifier
    // actually found the site, as opposed to confirmedMatch (a yes/no "did
    // it match the claim") which the milestone/land_listing tasks use.
    confirmedLocation: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    // Resolved place name/address for confirmedLocation — source is always
    // 'verifier_confirmed' here. Together with verifierId + updatedAt above,
    // this task document IS the full audit record of who confirmed what and
    // when; see verificationController.submitReport.
    confirmedLocationDetails: { type: LocationDetailsSchema, default: undefined },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

VerificationTaskSchema.index({ targetType: 1, targetId: 1 });
VerificationTaskSchema.index({ verifierId: 1, status: 1 });

module.exports = model('VerificationTask', VerificationTaskSchema);
