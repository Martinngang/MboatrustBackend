const { Schema, model } = require('mongoose');

/** A scheduled video call to verify a milestone flagged requiresVideo:true.
 * No video-calling provider is integrated in this codebase — meetingUrl is
 * a plain link a human pastes in (e.g. a Meet/Zoom link), not a generated one. */
const VideoVerificationSessionSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    milestoneId: { type: Schema.Types.ObjectId, required: true }, // Project.milestones subdocument _id
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    scheduledFor: { type: Date, default: null },
    meetingUrl: { type: String, default: '' },
    status: { type: String, enum: ['requested', 'scheduled', 'completed', 'cancelled'], default: 'requested' },
    notes: { type: String, default: '' },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

VideoVerificationSessionSchema.index({ projectId: 1, milestoneId: 1 });

module.exports = model('VideoVerificationSession', VideoVerificationSessionSchema);
