const { Schema, model } = require('mongoose');

const RiskFlagSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    flagType: {
      type: String,
      enum: ['multiple_disputes', 'duplicate_geotag', 'reused_evidence', 'ai_flagged', 'land_listing_risk', 'escrow_anomaly'],
      required: true,
    },
    severity: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
    detail: { type: Schema.Types.Mixed, default: {} },
    // Populated only when the AI second-opinion layer (see aiClient.js) runs
    // on top of an already-heuristic-flagged submission — null whenever AI
    // wasn't configured or wasn't triggered, never a placeholder value.
    aiRiskScore: { type: Number, min: 0, max: 100, default: null },
    aiRationale: { type: String, default: '' },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

RiskFlagSchema.index({ userId: 1 });
RiskFlagSchema.index({ severity: 1 });

module.exports = model('RiskFlag', RiskFlagSchema);
