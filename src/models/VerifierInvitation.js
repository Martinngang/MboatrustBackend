const { Schema, model } = require('mongoose');

/**
 * A funder-initiated invite for someone THEY already know to become the
 * verifier for one specific project's location-verification task — distinct
 * from VerifierProfile's global, admin-approved application pipeline.
 * Accepting this never creates or approves a VerifierProfile and never
 * touches the funder's own account; it only grants the accepting user
 * `roleType:'verifier'` (needed to reach the start/report endpoints) and
 * creates a VerificationTask scoped to them and this one project. See
 * controllers/verifierInvitationController.js.
 *
 * `tokenHash` is the only thing ever persisted — the raw token lives only in
 * the invite URL/email, following the same "never store the real secret"
 * convention as password/API-key handling elsewhere in this codebase.
 */
const VerifierInvitationSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    // Fixed for now — the polymorphic shape mirrors VerificationTask.targetType
    // so this can grow to invite verifiers for milestones/land listings later
    // without a schema change.
    targetType: { type: String, enum: ['project_location'], default: 'project_location' },
    invitedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, default: '' },
    tokenHash: { type: String, required: true, unique: true },
    status: { type: String, enum: ['pending', 'accepted', 'revoked', 'expired'], default: 'pending' },
    expiresAt: { type: Date, required: true },
    acceptedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    acceptedAt: { type: Date, default: null },
    verificationTaskId: { type: Schema.Types.ObjectId, ref: 'VerificationTask', default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

VerifierInvitationSchema.index({ projectId: 1, status: 1 });

module.exports = model('VerifierInvitation', VerifierInvitationSchema);
