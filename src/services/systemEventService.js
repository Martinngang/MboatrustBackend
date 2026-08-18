const { SystemEvent } = require('../models');
const logger = require('../config/logger');

/**
 * Records an infra/system-risk event — an AI call failing, a malformed
 * webhook, a frontend crash report. Wrapped so a failure here can never
 * break the request it's observing: every call site awaits this purely for
 * the (rare) side effect, the same convention escrowAnomalyService.
 * checkAndFlag already established for user-risk events.
 */
async function logEvent({ type, severity = 'error', source, detail = {}, userId = null }) {
  try {
    logger[severity === 'error' ? 'error' : severity === 'warning' ? 'warn' : 'info']({ type, source, detail, userId }, `[system-event] ${source}: ${type}`);
    return await SystemEvent.create({ type, severity, source, detail, userId });
  } catch (err) {
    logger.error({ err: err.message }, '[systemEventService] failed to persist event (non-blocking)');
    return null;
  }
}

module.exports = { logEvent };
