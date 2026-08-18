const { Schema, model } = require('mongoose');

/** Mirrors ContractorProfile's shape (specialties/regions/location/bio/
 * isAvailable) plus an application review state machine ContractorProfile
 * doesn't need — verifier is a trust-elevating role (see Phase 0's role
 * self-escalation fix), so it's never self-grantable; this is the real
 * application an admin reviews before granting it. */
const VerifierProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    specialties: { type: [String], default: [] },
    regions: { type: [String], default: [] },
    location: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    bio: { type: String, default: '' },
    idDocumentUrl: { type: String, default: '' },
    applicationStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    isAvailable: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

VerifierProfileSchema.index({ applicationStatus: 1 });
VerifierProfileSchema.index({ specialties: 1 });

module.exports = model('VerifierProfile', VerifierProfileSchema);
