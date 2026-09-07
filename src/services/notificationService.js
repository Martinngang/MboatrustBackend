const { Notification, NotificationPreference, User } = require('../models');
const { initFirebase } = require('../config/firebase');
const { categoryForType, DEFAULTS } = require('../utils/notificationCategories');
const { sendEmail } = require('./mailerService');
const { renderEmailHtml, contentForNotification } = require('../utils/emailTemplates');

// Account-status decisions a person needs to know about regardless of their
// marketing/category email toggle — the same reasoning most products apply
// to password-reset or security-alert emails never being gate-able. Every
// other type respects the recipient's per-category `email` preference.
const CRITICAL_TYPES = new Set([
  'kyc_verified',
  'kyc_rejected',
  'supplier_application_approved',
  'supplier_application_rejected',
  'verifier_application_approved',
  'verifier_application_rejected',
  // Admin actions on a user's account/standing — same "never gate-able"
  // reasoning, see utils/notificationCategories.js's ADMIN_ACTION_TYPES
  // comment for the full list this pairs with.
  'account_deactivated',
  'account_reactivated',
  'account_deleted',
  'password_changed_by_admin',
  'role_granted',
  'role_revoked',
  'contractor_certification_verified',
  'contractor_certification_rejected',
  'contractor_certification_removed',
  'land_listing_verified',
  'land_listing_verification_rejected',
  'land_listing_removed',
  'subscription_force_cancelled',
  'contract_terminated',
  'escrow_refunded',
  'escrow_removed',
  'referral_removed',
  'rating_removed_by_admin',
  'admin_permissions_changed',
]);

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

/** Same "never block the caller" contract as sendPush — a bad address or a
 * provider outage must not fail the request that triggered the notification.
 * `meta` (adminId/relatedAction/relatedType/relatedId) is purely for the
 * EmailLog audit trail — see mailerService.sendEmail's own doc comment. */
async function sendEmailForNotification(userId, type, payload, meta = {}) {
  try {
    const user = await User.findById(userId).select('email fullName').lean();
    const content = contentForNotification(type, payload, user);
    await sendEmail(
      { to: user?.email, subject: content.subject, html: renderEmailHtml(content) },
      {
        recipientUserId: userId,
        type,
        triggeredByAdminId: meta.adminId || null,
        relatedAction: meta.relatedAction || null,
        relatedType: meta.relatedType || null,
        relatedId: meta.relatedId || null,
      }
    );
  } catch (err) {
    console.warn(`[notificationService] email send failed for user ${userId}:`, err.message);
  }
}

/**
 * Creates the in-app Notification record — this is the base feed itself,
 * not a togglable channel (the frontend's preferences screen only ever
 * offers push/email toggles, never an "in-app" one) — so it's created
 * unconditionally. Push and email delivery are each gated on the
 * recipient's per-category preference, except CRITICAL_TYPES (account
 * status decisions), which always email regardless of that toggle.
 *
 * `meta` is optional and admin-only: pass `{ adminId, relatedAction,
 * relatedType, relatedId }` (matching the adminActionLogService.logAdminAction
 * call for the same mutation) when this notify() is a direct consequence of
 * an admin action, so the EmailLog entry cross-references it. Every existing
 * non-admin call site is unaffected — the param just defaults away.
 */
async function notify(userId, type, payload = {}, meta = {}) {
  const notification = await Notification.create({ userId, type, payload, read: false });
  const category = categoryForType(type);
  const channels = await getChannelPrefs(userId, category);
  if (channels.push) await sendPush(userId, type, payload);
  if (CRITICAL_TYPES.has(type) || channels.email) await sendEmailForNotification(userId, type, payload, meta);
  return notification;
}

async function notifyMany(userIds, type, payload = {}, extra = {}, meta = {}) {
  const docs = userIds.map((userId) => ({ userId, type, payload, read: false, ...extra }));
  const created = await Notification.insertMany(docs);
  const category = categoryForType(type);
  await Promise.all(
    userIds.map(async (userId) => {
      const channels = await getChannelPrefs(userId, category);
      if (channels.push) await sendPush(userId, type, payload);
      if (CRITICAL_TYPES.has(type) || channels.email) await sendEmailForNotification(userId, type, payload, meta);
    })
  );
  return created;
}

module.exports = { notify, notifyMany };
