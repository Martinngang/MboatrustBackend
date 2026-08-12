const { Referral } = require('../models');
const notificationService = require('./notificationService');

// A flat bonus, not a percentage — this is a one-time thank-you for
// bringing in an active user, not tied to the size of what they funded/earned.
const REFERRAL_REWARD_AMOUNT = 5000;
const REFERRAL_REWARD_CURRENCY = 'XAF';

/**
 * Called wherever a referred user completes their first real piece of work
 * on the platform (a funding/tender/land project they own reaching
 * 'completed', or a contract they're the contractor on reaching
 * 'completed') — rewards the referrer exactly once. A no-op if this user
 * was never referred, or their referral was already rewarded (status is
 * only ever 'joined' the one time this can fire).
 */
async function maybeRewardReferral(referredUserId) {
  const referral = await Referral.findOne({ referredId: referredUserId, status: 'joined' });
  if (!referral) return null;

  referral.status = 'rewarded';
  referral.rewardAmount = REFERRAL_REWARD_AMOUNT;
  referral.rewardCurrency = REFERRAL_REWARD_CURRENCY;
  await referral.save();

  await notificationService.notify(referral.referrerId, 'referral_rewarded', {
    referralId: referral._id,
    amount: REFERRAL_REWARD_AMOUNT,
  });
  return referral;
}

module.exports = { maybeRewardReferral, REFERRAL_REWARD_AMOUNT };
