const { Schema, model } = require('mongoose');

const ReferralSchema = new Schema(
  {
    referrerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    referredId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['invited', 'joined', 'rewarded'], default: 'invited' },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

ReferralSchema.index({ referrerId: 1 });

module.exports = model('Referral', ReferralSchema);
