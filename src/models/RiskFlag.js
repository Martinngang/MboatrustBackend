const { Schema, model } = require('mongoose');

const RiskFlagSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    flagType: {
      type: String,
      enum: ['multiple_disputes', 'duplicate_geotag', 'reused_evidence'],
      required: true,
    },
    severity: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
    detail: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

RiskFlagSchema.index({ userId: 1 });
RiskFlagSchema.index({ severity: 1 });

module.exports = model('RiskFlag', RiskFlagSchema);
