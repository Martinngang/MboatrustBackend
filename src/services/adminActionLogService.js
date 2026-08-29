const { AdminActionLog } = require('../models');
const logger = require('../config/logger');

/**
 * Records an admin-initiated mutation — who did what to which record.
 * Wrapped so a logging failure can never break the mutation it's
 * observing: same non-blocking, try/catch-and-swallow convention
 * systemEventService.logEvent already established. Call this AFTER the
 * real mutation has already succeeded, never before.
 */
async function logAdminAction({ adminId, action, targetType, targetId, detail = {} }) {
  try {
    return await AdminActionLog.create({ adminId, action, targetType, targetId, detail });
  } catch (err) {
    logger.error({ err: err.message, action, targetType, targetId }, '[adminActionLogService] failed to persist action (non-blocking)');
    return null;
  }
}

module.exports = { logAdminAction };
