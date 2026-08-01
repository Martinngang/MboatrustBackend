const { Schema, model } = require('mongoose');

const ContractSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    bidId: { type: Schema.Types.ObjectId, ref: 'Bid', required: true },
    generatedDocumentUrl: { type: String, default: null },
    // Plain-text contract terms generated at acceptance time — a real PDF
    // render + Cloudinary upload (populating generatedDocumentUrl) is a
    // follow-up once storage credentials are configured; this keeps the
    // "digital contract" concept genuinely backed by real bid/project data
    // in the meantime rather than left entirely unimplemented.
    generatedDocumentText: { type: String, default: null },
    status: { type: String, enum: ['active', 'completed', 'terminated'], default: 'active' },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

ContractSchema.index({ projectId: 1 });

module.exports = model('Contract', ContractSchema);
