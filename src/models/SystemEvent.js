const { Schema, model } = require('mongoose');

/** Infra/system risk, parallel to RiskFlag (which is user/fraud risk) — an
 * AI call failing, a malformed webhook payload, a frontend crash. userId is
 * nullable since a pre-login frontend crash or a webhook failure has no
 * user to attribute it to. */
const SystemEventSchema = new Schema(
  {
    type: { type: String, required: true }, // e.g. 'ai_call_failed', 'webhook_error', 'frontend_crash', 'rate_limited'
    severity: { type: String, enum: ['info', 'warning', 'error'], default: 'error' },
    source: { type: String, required: true }, // e.g. 'evidenceAnalysisService', 'flutterwaveWebhook', 'frontend'
    detail: { type: Schema.Types.Mixed, default: {} },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

SystemEventSchema.index({ type: 1, createdAt: -1 });
SystemEventSchema.index({ severity: 1 });

module.exports = model('SystemEvent', SystemEventSchema);
