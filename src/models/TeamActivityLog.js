const { Schema, model } = require('mongoose');

/** Durable audit trail for a contractor's own team/delegation actions —
 * mirrors AdminActionLogSchema's shape (actor/action/target/detail) but
 * keyed by `ownerId` (the contractor whose team this is) rather than an
 * admin, since this is a self-service feature with no admin involved.
 * The per-user activity feed (services/activityService.js) is derived-live
 * and isn't a fit for "who did what to this team, ever" — this is that
 * missing durable record, written via services/teamActivityLogService.js. */
const TeamActivityLogSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // e.g. 'member.invited', 'member.permissionsChanged', 'member.removed',
    // 'milestone.submittedOnBehalf'
    action: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    detail: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

TeamActivityLogSchema.index({ ownerId: 1, createdAt: -1 });

module.exports = model('TeamActivityLog', TeamActivityLogSchema);
