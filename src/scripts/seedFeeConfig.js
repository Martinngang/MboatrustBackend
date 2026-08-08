// Seeds default FeeConfig documents so feeService.calculateFee has values
// to read on first run. Re-run any time to reset to these defaults.
const { connectDB } = require('../config/db');
const { FeeConfig } = require('../models');
const mongoose = require('mongoose');

const DEFAULTS = [
  { feeType: 'project_funding', value: 0.02, isFlat: false }, // 2% platform fee when a funder sends money in
  { feeType: 'currency_conversion', value: 0.015, isFlat: false }, // 1.5% spread on currency conversion
  { feeType: 'milestone_release', value: 0.03, isFlat: false }, // 3% platform fee when a milestone payout releases
  { feeType: 'land_sale', value: 0.015, isFlat: false }, // 1.5% platform fee on a verified land sale
  { feeType: 'refund', value: 0, isFlat: true }, // no fee on refunds
];

async function run() {
  await connectDB();
  for (const config of DEFAULTS) {
    await FeeConfig.findOneAndUpdate({ feeType: config.feeType }, config, {
      upsert: true,
      new: true,
    });
    console.log(`[seed] upserted fee config: ${config.feeType}`);
  }
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
