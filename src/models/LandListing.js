const { Schema, model } = require('mongoose');

const LandDocumentSchema = new Schema(
  {
    type: { type: String, required: true },
    fileUrl: { type: String, required: true },
    verificationStatus: {
      type: String,
      enum: ['unverified', 'pending', 'verified', 'flagged'],
      default: 'unverified',
    },
  },
  { _id: false }
);

const LandListingSchema = new Schema(
  {
    sellerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Display fields — not in the architecture doc's minimal schema, added
    // the same way Project gained locationName/imageUrl: the doc models
    // the fields that matter for the escrow/verification logic, listing
    // presentation needs a few more that don't affect that logic.
    title: { type: String, default: '' },
    region: { type: String, default: '' },
    city: { type: String, default: '' },
    titleType: { type: String, default: '' },
    description: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    sizeSqm: { type: Number, required: true, min: 0 },
    price: { type: Number, required: true, min: 0 },
    location: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    documents: { type: [LandDocumentSchema], default: [] },
    verificationStatus: {
      type: String,
      enum: ['unverified', 'pending', 'verified', 'flagged'],
      default: 'unverified',
    },
    disputeFlag: { type: Boolean, default: false },
    disputeReason: { type: String, default: '' },
    // Set by server-side proximity+size matching against other listings at
    // creation time (see landDuplicateService) — the land-pillar analogue
    // of the evidence file-hash duplicate check in the funding pillar.
    duplicateOfListingId: { type: Schema.Types.ObjectId, ref: 'LandListing', default: null },
    linkedProjectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

LandListingSchema.index({ verificationStatus: 1 });
LandListingSchema.index({ 'location.lat': 1, 'location.lng': 1 });

module.exports = model('LandListing', LandListingSchema);
