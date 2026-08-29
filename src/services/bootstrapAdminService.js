const env = require('../config/env');
const { User } = require('../models');

/**
 * Solves the "zero admins, no path to the first one" problem: granting the
 * admin role normally requires an existing admin (see adminUserRoutes.js),
 * which a brand-new production database doesn't have. Run once at server
 * startup — if INITIAL_ADMIN_EMAIL is set and matches a real, already-
 * registered account that isn't an admin yet, grants it. Deliberately never
 * creates a User — an email with no matching account yet just logs and
 * waits for the next restart after that person has actually signed up.
 * Safe to leave the env var set indefinitely: once granted, every later
 * call is a no-op (only reads state, still no query at all when the env
 * var is blank).
 */
async function bootstrapInitialAdmin() {
  if (!env.initialAdminEmail) return;

  const user = await User.findOne({ email: env.initialAdminEmail });
  if (!user) {
    console.warn(`[bootstrapAdmin] INITIAL_ADMIN_EMAIL "${env.initialAdminEmail}" has no matching account yet — will retry on next server start.`);
    return;
  }

  if (user.roles.some((r) => r.roleType === 'admin')) {
    return; // already done — the common case on every restart after the first.
  }

  user.roles.push({ roleType: 'admin' });
  await user.save();
  console.log(`[bootstrapAdmin] Granted admin to ${user.email} (${user._id}) via INITIAL_ADMIN_EMAIL.`);
}

module.exports = { bootstrapInitialAdmin };
