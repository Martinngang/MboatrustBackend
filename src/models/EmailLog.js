const { Schema, model } = require('mongoose');

/** Delivery record for every email mailerService.sendEmail() has ever
 * attempted — distinct from AdminActionLog (records the admin's decision)
 * and Notification (the in-app feed): this is "did the email actually go
 * out," independent of whether the underlying action was admin-triggered.
 * Written on every attempt, including a skip (no SMTP configured, no
 * recipient address), so the admin dashboard can show real delivery
 * status/failures instead of just assuming notify() calls succeeded. */
const EmailLogSchema = new Schema(
  {
    recipientUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    recipientEmail: { type: String, default: '' },
    type: { type: String, required: true },
    subject: { type: String, required: true },
    status: { type: String, enum: ['sent', 'failed', 'skipped'], required: true },
    // Populated only on 'failed' (the provider error) or 'skipped' (why —
    // 'smtp_not_configured' / 'no_recipient_email').
    error: { type: String, default: null },
    // Present only when this email was a direct consequence of an admin
    // mutation — lets the admin dashboard cross-reference "this action" to
    // "did the affected user actually get emailed about it."
    triggeredByAdminId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    relatedAction: { type: String, default: null }, // matches AdminActionLog.action, e.g. 'user.deactivate'
    relatedType: { type: String, default: null },
    relatedId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

EmailLogSchema.index({ createdAt: -1 });
EmailLogSchema.index({ recipientUserId: 1, createdAt: -1 });
EmailLogSchema.index({ status: 1, createdAt: -1 });
EmailLogSchema.index({ triggeredByAdminId: 1, createdAt: -1 });

module.exports = model('EmailLog', EmailLogSchema);
