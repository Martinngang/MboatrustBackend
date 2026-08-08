const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { Escrow } = require('../models');

async function run() {
  await connectDB();
  console.log('[migrate] finding escrows missing providerRole');
  const cursor = Escrow.find({ providerRole: { $exists: false } }).cursor();
  let count = 0;
  for await (const doc of cursor) {
    const role = doc.type === 'fund' ? 'collection' : 'disbursement';
    doc.providerRole = role;
    if (!doc.currencyConversion) doc.currencyConversion = null;
    await doc.save();
    count += 1;
  }
  console.log(`[migrate] updated ${count} escrow documents`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
