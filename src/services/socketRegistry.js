let io = null;

/** Called once from server.js right after the Socket.IO server is created. */
function setIO(instance) {
  io = instance;
}

/** May legitimately return null — e.g. inside the standalone
 * chargeRecurringContributions.js cron process, which calls
 * notificationService.notify() but never runs server.js's setIO(). Callers
 * must guard with `if (io) ...` rather than assume a live socket server. */
function getIO() {
  return io;
}

module.exports = { setIO, getIO };
