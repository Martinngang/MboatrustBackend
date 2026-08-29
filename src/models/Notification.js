const { Schema, model } = require('mongoose');

const NotificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    read: { type: Boolean, default: false },
    // Set only for admin broadcast sends (adminNotificationController.broadcast) —
    // null for every ordinary system-triggered notification. broadcastId groups
    // the one insertMany batch so the admin history view can show it as one row.
    broadcastId: { type: Schema.Types.ObjectId, default: null, index: true },
    sentByAdminId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

NotificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

module.exports = model('Notification', NotificationSchema);
