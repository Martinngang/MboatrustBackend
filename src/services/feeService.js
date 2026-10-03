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

/**
 * Inverse of calculateFee for "fee on top" pricing: given the amount that
 * should end up credited (net), what must be paid (gross) so that
 * calculateFee(type, gross).netAmount === net. Used by staged funding so a
 * funder who wants to cover a 10M milestone is quoted the real amount to pay
 * instead of silently landing a fee short.
 */
async function grossForNet(transactionType, netAmount, currency = 'XAF') {
  const config = await FeeConfig.findOne({ feeType: transactionType }).lean();
  let gross = netAmount;
  if (config && config.isFlat) gross = netAmount + config.value;
  else if (config && config.value > 0 && config.value < 1) gross = netAmount / (1 - config.value);
  gross = Math.ceil(gross * 100) / 100;
  // The fee rounds to 2dp, so neighbouring gross values (±0.02) can credit a
  // net a centime above or below the target — pick the one closest to it
  // (ties → the higher net) instead of always overshooting.
  let best = null;
  for (const delta of [-0.02, -0.01, 0, 0.01, 0.02]) {
    const g = Math.round((gross + delta) * 100) / 100;
    if (g <= 0) continue;
    const f = await calculateFee(transactionType, g, currency);
    const diff = Math.abs(f.netAmount - netAmount);
    if (!best || diff < best.diff - 1e-9 || (Math.abs(diff - best.diff) < 1e-9 && f.netAmount > best.fee.netAmount)) {
      best = { fee: f, diff };
    }
  }
  return best.fee;
}

module.exports = { calculateFee, grossForNet };
