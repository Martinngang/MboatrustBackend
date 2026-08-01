const { Schema, model } = require('mongoose');

const SubscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    planType: { type: String, enum: ['pro_contractor', 'power_funder'], required: true },
    status: { type: String, enum: ['active', 'cancelled', 'expired', 'past_due'], default: 'active' },
    renewalDate: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

SubscriptionSchema.index({ userId: 1 });

module.exports = model('Subscription', SubscriptionSchema);
