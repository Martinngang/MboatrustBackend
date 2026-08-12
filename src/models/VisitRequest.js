const { Schema, model } = require('mongoose');

/** Same shape as VideoVerificationSession — a buyer proposes dates to visit
 * a land listing in person, the seller confirms one, either can cancel. */
const VisitRequestSchema = new Schema(
  {
    listingId: { type: Schema.Types.ObjectId, ref: 'LandListing', required: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    proposedDates: { type: [Date], default: [] },
    confirmedDate: { type: Date, default: null },
    status: { type: String, enum: ['requested', 'confirmed', 'completed', 'cancelled'], default: 'requested' },
    notes: { type: String, default: '' },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

VisitRequestSchema.index({ listingId: 1 });
VisitRequestSchema.index({ requestedBy: 1 });

module.exports = model('VisitRequest', VisitRequestSchema);
