const { FeeConfig } = require('../models');

/**
 * Single shared fee calculation, called by every route that touches money
 * (milestone release, bid payout, land sale). Persist the result into
 * Escrow.feeBreakdown at transaction time so historical records stay
 * accurate even if FeeConfig values change later.
 */
async function calculateFee(transactionType, grossAmount, currency = 'XAF') {
  const config = await FeeConfig.findOne({ feeType: transactionType }).lean();
  const feeRate = config && !config.isFlat ? config.value : 0;
  const flatFee = config && config.isFlat ? config.value : 0;

  const feeAmount = config ? (config.isFlat ? flatFee : grossAmount * feeRate) : 0;
  const netAmount = Math.max(0, grossAmount - feeAmount);

  return {
    grossAmount,
    feeType: transactionType,
    feeRate: config && !config.isFlat ? feeRate : 0,
    feeAmount: Math.round(feeAmount * 100) / 100,
    netAmount: Math.round(netAmount * 100) / 100,
    currency,
    computedAt: new Date(),
  };
}

module.exports = { calculateFee };
