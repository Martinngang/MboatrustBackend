const { Schema, model } = require('mongoose');

/** Real audit trail for admin-initiated mutations — distinct from
 * SystemEvent (infra/system risk) and RiskFlag (user/fraud risk). Nothing
 * previously recorded WHO deactivated a user, forced a refund, or resolved
 * a dispute; this is the single place every such action gets written, via
 * services/adminActionLogService.js. */
const AdminActionLogSchema = new Schema(
  {
    adminId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // e.g. 'user.deactivate', 'user.grantRole', 'escrow.refund', 'dispute.resolve'
    action: { type: String, required: true },
    // e.g. 'User', 'Escrow', 'Dispute', 'VerifierProfile', 'ContractorCertification'
    targetType: { type: String, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    detail: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

AdminActionLogSchema.index({ createdAt: -1 });
AdminActionLogSchema.index({ adminId: 1, createdAt: -1 });
AdminActionLogSchema.index({ targetType: 1, targetId: 1 });

module.exports = model('AdminActionLog', AdminActionLogSchema);
