const { Notification, NotificationPreference, User } = require('../models');
const { initFirebase } = require('../config/firebase');
const { categoryForType, DEFAULTS } = require('../utils/notificationCategories');

/** A user with no NotificationPreference doc yet gets every category's
 * documented default (see utils/notificationCategories.DEFAULTS) — never
 * silently suppressed just because they've never opened the settings screen. */
async function getChannelPrefs(userId, category) {
  const pref = await NotificationPreference.findOne({ userId }).lean();
  return pref?.prefs?.[category] || DEFAULTS[category];
}

async function sendPush(userId, type, payload) {
  const admin = initFirebase();
  if (!admin) return; // not configured — silently skip, never block the caller
  const user = await User.findById(userId).select('fcmDeviceToken').lean();
  if (!user?.fcmDeviceToken) return; // no device registered yet

  try {
    await admin.messaging().send({
      token: user.fcmDeviceToken,
      notification: { title: 'Mboa Trust', body: humanize(type) },
      data: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v)])),
    });
  } catch (err) {
    // A push failure (expired token, etc.) must never fail the request that
    // triggered the notification — log and move on.
    console.warn(`[notificationService] push send failed for user ${userId}:`, err.message);
  }
}

function humanize(type) {
  return type.replace(/_/g, ' ');
}

/**
 * Creates the in-app Notification record — this is the base feed itself,
 * not a togglable channel (the frontend's preferences screen only ever
 * offers push/email toggles, never an "in-app" one) — so it's created
 * unconditionally. Push delivery is gated on the recipient's per-category
 * preference. Email is stored as a preference but never sent — no email
 * provider is integrated in this backend.
 */
async function notify(userId, type, payload = {}) {
  const notification = await Notification.create({ userId, type, payload, read: false });
  const category = categoryForType(type);
  const channels = await getChannelPrefs(userId, category);
  if (channels.push) await sendPush(userId, type, payload);
  return notification;
}

async function notifyMany(userIds, type, payload = {}) {
  const docs = userIds.map((userId) => ({ userId, type, payload, read: false }));
  const created = await Notification.insertMany(docs);
  const category = categoryForType(type);
  await Promise.all(
    userIds.map(async (userId) => {
      const channels = await getChannelPrefs(userId, category);
      if (channels.push) await sendPush(userId, type, payload);
    })
  );
  return created;
}

module.exports = { notify, notifyMany };
