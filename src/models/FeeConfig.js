const { Schema, model } = require('mongoose');

// Single source of truth for all fee %/flat values. One document per feeType.
const FeeConfigSchema = new Schema(
  {
    feeType: { type: String, required: true, unique: true },
    value: { type: Number, required: true, min: 0 }, // interpreted as a rate (e.g. 0.02) unless isFlat is true
    isFlat: { type: Boolean, default: false },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

module.exports = model('FeeConfig', FeeConfigSchema);
