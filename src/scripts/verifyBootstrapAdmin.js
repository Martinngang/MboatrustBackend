// Proves the INITIAL_ADMIN_EMAIL bootstrap actually grants admin to a real
// account, is idempotent on repeat runs (every server restart calls it),
// and does nothing destructive when the email is blank or unmatched. Talks
// to the database directly (like verifyRoleSecurity.js) rather than the
// HTTP API, since bootstrapInitialAdmin runs at server startup, before any
// request handling exists. Safe to re-run — its one fixture is tagged and
// removed at the end, pass or fail.
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const env = require('../config/env');
const { User } = require('../models');
const { bootstrapInitialAdmin } = require('../services/bootstrapAdminService');

const TAG = 'verify-bootstrap-admin-script';

const results = [];
function record(label, passed, detail = '') {
  results.push({ label, passed });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

async function run() {
  await connectDB();
  const originalEmail = env.initialAdminEmail; // restored at the end regardless of outcome
  let userId;

  try {
    const email = `${TAG}-${Date.now()}@test.local`;
    const user = await User.create({
      fullName: `${TAG} Target`,
      email,
      firebaseUid: `${TAG}-${Date.now()}`,
      roles: [],
    });
    userId = user._id;

    // ── 1. Blank env var: no-op, no crash ──────────────────────────────
    env.initialAdminEmail = '';
    await bootstrapInitialAdmin();
    const afterBlank = await User.findById(userId).lean();
    record('Blank INITIAL_ADMIN_EMAIL grants nothing', !afterBlank.roles.some((r) => r.roleType === 'admin'));

    // ── 2. Unmatched email: no-op, no crash ────────────────────────────
    env.initialAdminEmail = `${TAG}-nobody-${Date.now()}@test.local`;
    await bootstrapInitialAdmin();
    const afterUnmatched = await User.findById(userId).lean();
    record('Unmatched email grants nothing (and does not throw)', !afterUnmatched.roles.some((r) => r.roleType === 'admin'));

    // ── 3. Matching email: grants admin ────────────────────────────────
    env.initialAdminEmail = email.toLowerCase();
    await bootstrapInitialAdmin();
    const afterGrant = await User.findById(userId).lean();
    record('Matching INITIAL_ADMIN_EMAIL grants admin to that account', afterGrant.roles.some((r) => r.roleType === 'admin'));

    // ── 4. Idempotent: a second run (every later server restart) is a no-op ──
    await bootstrapInitialAdmin();
    const afterSecondRun = await User.findById(userId).lean();
    const adminCount = afterSecondRun.roles.filter((r) => r.roleType === 'admin').length;
    record('Re-running (as every restart does) does not duplicate the role', adminCount === 1, `admin entries: ${adminCount}`);

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error('\n[verify] Could not reach MongoDB — is it running?');
    }
    throw err;
  } finally {
    env.initialAdminEmail = originalEmail;
    if (userId) await User.deleteOne({ _id: userId });
    console.log('\n[cleanup] verification fixture removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
