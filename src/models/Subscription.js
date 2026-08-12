const { Schema, model } = require('mongoose');

const SubscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    planType: { type: String, enum: ['pro_contractor', 'power_funder'], required: true },
    status: { type: String, enum: ['active', 'cancelled', 'expired', 'past_due'], default: 'active' },
    renewalDate: { type: Date, default: null },
    // Stored from the charge that created/last-renewed this subscription —
    // same reason PooledContribution stores it (see FB4): MTN MoMo needs a
    // real MSISDN on every collection call, an automated renewal charge
    // can't reuse an authorization the way a card token would.
    payerPhoneNumber: { type: String, default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

SubscriptionSchema.index({ userId: 1 });

module.exports = model('Subscription', SubscriptionSchema);
