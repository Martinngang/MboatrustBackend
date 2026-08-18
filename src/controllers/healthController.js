const mongoose = require('mongoose');
const { SystemEvent } = require('../models');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const env = require('../config/env');

function configPresence() {
  return {
    gemini: Boolean(env.ai.geminiApiKey),
    cloudinary: Boolean(env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret),
    stripe: Boolean(env.stripe.secretKey),
    flutterwave: Boolean(env.flutterwave.secretKey),
    firebase: Boolean(env.firebase.serviceAccountJson || env.firebase.serviceAccountPath),
    mtnMomo: Boolean(env.momo.apiUser && env.momo.apiKey && env.momo.subscriptionKey),
    orangeMoney: Boolean(env.orangeMoney.clientId && env.orangeMoney.clientSecret),
  };
}

/**
 * Replaces the old static {status,env} stub with a real check: actual
 * Mongoose connection state, plus which optional integrations have
 * credentials configured. Never makes a live network call to any of those
 * integrations (a slow/down third party must never make this endpoint
 * slow/down too) and never fails on a missing *optional* config — only a
 * real DB disconnect degrades the response, since that's the one dependency
 * this app cannot function at all without.
 */
const getHealth = (req, res) => {
  const dbConnected = mongoose.connection.readyState === 1; // 1 = connected
  const status = dbConnected ? 'ok' : 'degraded';
  return res.status(dbConnected ? 200 : 503).json({ status, env: env.nodeEnv, db: { connected: dbConnected }, config: configPresence() });
};

const RECENT_WINDOW_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const RECENT_EVENTS_LIMIT = 30;

/**
 * Admin-only dashboard view — same aggregation style as
 * platformStatsController.getPlatformStats (real counts over an existing
 * collection, no separate tracking system). Same db/config booleans as the
 * public /health check, plus SystemEvent counts and a recent-events list so
 * an admin can actually see what's been going wrong, not just that
 * something has.
 */
const getSystemHealth = catchAsync(async (req, res) => {
  const since = new Date(Date.now() - RECENT_WINDOW_MS);
  const dbConnected = mongoose.connection.readyState === 1;

  const [countByTypeAgg, countBySeverityAgg, recentEvents] = await Promise.all([
    SystemEvent.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
    ]),
    SystemEvent.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$severity', count: { $sum: 1 } } },
    ]),
    SystemEvent.find({}).sort('-createdAt').limit(RECENT_EVENTS_LIMIT).lean(),
  ]);

  return ok(res, {
    db: { connected: dbConnected },
    config: configPresence(),
    since,
    countByType: Object.fromEntries(countByTypeAgg.map((r) => [r._id, r.count])),
    countBySeverity: Object.fromEntries(countBySeverityAgg.map((r) => [r._id, r.count])),
    recentEvents,
  });
});

module.exports = { getHealth, getSystemHealth };
