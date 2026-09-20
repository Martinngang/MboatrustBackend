const rateLimit = require('express-rate-limit');
const { logEvent } = require('../services/systemEventService');

/** A second, tighter, per-user limiter layered on top of app.js's app-wide
 * per-IP limiter — applied only to the two message-send routes that can
 * reach the AI Advisor (see advisorReplyService.js), since those are the
 * only requests that can trigger a real, billed Gemini call. Generous
 * enough (60/10min) to never affect normal human-to-human chat. */
module.exports = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?._id || req.ip),
  handler: (req, res) => {
    logEvent({ type: 'rate_limited', severity: 'warning', source: 'aiChatRateLimit', detail: { userId: req.user?._id, path: req.path } }).catch(() => {});
    res.status(429).json({ success: false, error: { message: 'Too many messages sent — please slow down and try again shortly.' } });
  },
});
