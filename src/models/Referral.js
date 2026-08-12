const { Schema, model } = require('mongoose');

const ReferralSchema = new Schema(
  {
    referrerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    referredId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['invited', 'joined', 'rewarded'], default: 'invited' },
    // Set only when status flips to 'rewarded' — see
    // referralService.maybeRewardReferral. No wallet/credit-balance concept
    // exists anywhere else in this codebase (checked Subscription and
    // FeeConfig first) so the reward is stored as a flat record here rather
    // than inventing a new ledger system nobody asked for.
    rewardAmount: { type: Number, default: null },
    rewardCurrency: { type: String, default: 'XAF' },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

ReferralSchema.index({ referrerId: 1 });

module.exports = model('Referral', ReferralSchema);
