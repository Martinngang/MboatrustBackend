const { Schema, model } = require('mongoose');

const NotificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    read: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

NotificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

module.exports = model('Notification', NotificationSchema);
