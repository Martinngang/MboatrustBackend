// One-off data migration: strips the retired 'recipient' role entry from
// every User.roles[] that has one. Never deletes the User document, never
// touches any other role on the same account, and never touches
// Project/Escrow documents — historical funding-project/recipient-payee
// records are kept exactly as they are (see projectController.js's
// assertCanCreateProjectType and Escrow.js's payeeType enum comments).
// Idempotent: safe to run more than once — a second run matches zero users.
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User } = require('../models');

async function run() {
  await connectDB();
  console.log("[migrate] finding users with a 'recipient' role entry");
  const cursor = User.find({ 'roles.roleType': 'recipient' }).cursor();
  let usersUpdated = 0;
  let rolesRemoved = 0;
  for await (const doc of cursor) {
    const before = doc.roles.length;
    doc.roles = doc.roles.filter((r) => r.roleType !== 'recipient');
    const removed = before - doc.roles.length;
    if (removed > 0) {
      await doc.save();
      usersUpdated += 1;
      rolesRemoved += removed;
    }
  }
  console.log(`[migrate] stripped 'recipient' role from ${usersUpdated} users (${rolesRemoved} role entries removed)`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
