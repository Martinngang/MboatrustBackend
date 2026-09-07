const { z } = require('zod');

// Mirrors ADMIN_NAV's section keys on the frontend (components/shell/
// adminNav.ts) — the fixed set of permission keys a restricted admin can be
// granted. `permissions: null` clears any restriction (back to unrestricted).
const ADMIN_PERMISSION_KEYS = ['overview', 'users', 'projects', 'land', 'contractors', 'community', 'disputes', 'fraud', 'verifications', 'notifications', 'support', 'settings', 'admins'];

const setPermissions = z.object({
  permissions: z.array(z.enum(ADMIN_PERMISSION_KEYS)).nullable(),
});

module.exports = { setPermissions, ADMIN_PERMISSION_KEYS };
