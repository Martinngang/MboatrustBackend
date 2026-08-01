const { Notification } = require('../models');

/**
 * Creates a persisted Notification doc. Push delivery (Firebase Cloud
 * Messaging) is a later wiring step — this keeps the in-app notification
 * feed working today regardless of whether push is configured.
 */
async function notify(userId, type, payload = {}) {
  return Notification.create({ userId, type, payload, read: false });
}

async function notifyMany(userIds, type, payload = {}) {
  const docs = userIds.map((userId) => ({ userId, type, payload, read: false }));
  return Notification.insertMany(docs);
}

module.exports = { notify, notifyMany };
