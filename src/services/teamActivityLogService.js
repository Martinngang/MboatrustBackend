const { TeamActivityLog } = require('../models');
const logger = require('../config/logger');

/**
 * Records a contractor-team/delegation event — same non-blocking,
 * try/catch-and-swallow contract as adminActionLogService.logAdminAction.
 * Call this AFTER the real mutation has already succeeded.
 */
async function logTeamActivity({ ownerId, actorId, action, targetType, targetId, detail = {} }) {
  try {
    return await TeamActivityLog.create({ ownerId, actorId, action, targetType, targetId, detail });
  } catch (err) {
    logger.error({ err: err.message, action, targetType, targetId }, '[teamActivityLogService] failed to persist action (non-blocking)');
    return null;
  }
}

module.exports = { logTeamActivity };
