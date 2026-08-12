const { Schema, model } = require('mongoose');

const ContractorCertificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    issuer: { type: String, required: true },
    issuedAt: { type: Date, default: null },
    documentUrl: { type: String, default: '' },
    // Admin-settable only — a contractor uploading their own certificate
    // can't self-verify it. Mutually exclusive with `rejected` (both flip
    // back to false when the other is set — see contractorCertificationController).
    verified: { type: Boolean, default: false },
    rejected: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

ContractorCertificationSchema.index({ userId: 1 });

module.exports = model('ContractorCertification', ContractorCertificationSchema);
