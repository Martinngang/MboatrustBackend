const { Schema, model } = require('mongoose');

const EvidenceSchema = new Schema(
  {
    type: { type: String, enum: ['photo', 'video'], required: true },
    fileUrl: { type: String, required: true },
    notes: { type: String, default: '', trim: true },
    geotag: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    capturedAt: { type: Date, default: Date.now },
    fileHash: { type: String, default: null },
    locationMatch: { type: Boolean, default: null },
    timestampRecent: { type: Boolean, default: null },
    duplicateFlag: { type: Boolean, default: false },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

const ApproverSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    decidedAt: { type: Date, default: null },
  },
  { _id: false }
);

const MilestoneSchema = new Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: '' },
    amount: { type: Number, required: true, min: 0 },
    orderIndex: { type: Number, required: true },
    status: {
      type: String,
      enum: ['pending', 'submitted', 'under_review', 'approved', 'disputed', 'released'],
      default: 'pending',
    },
    requiresVideo: { type: Boolean, default: false },
    requiresVerifier: { type: Boolean, default: false },
    requiresCosigner: { type: Boolean, default: false },
    evidence: { type: [EvidenceSchema], default: [] },
    approvers: { type: [ApproverSchema], default: [] },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

const ProjectSchema = new Schema(
  {
    projectType: { type: String, enum: ['funding', 'tender', 'land_purchase'], required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    category: { type: String, default: '' },
    // Human-readable place name ("Bamenda, NW Region") shown in list/detail
    // UI, distinct from `location` below which holds precise coordinates
    // used for evidence geotag matching.
    locationName: { type: String, default: '' },
    location: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    imageUrl: { type: String, default: '' },
    // Tender bid-submission cutoff — nullable since the funding pillar has no deadline concept.
    deadline: { type: Date, default: null },
    totalAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'XAF' },
    status: {
      type: String,
      enum: ['draft', 'open', 'funded', 'in_progress', 'completed', 'disputed', 'cancelled'],
      default: 'draft',
    },
    requiresMultiSig: { type: Boolean, default: false },
    // The second required signer for requiresMultiSig / any milestone with
    // requiresCosigner — null until the owner adds one via POST
    // /projects/:id/co-signer. No pre-existing co-signer identity concept
    // existed anywhere in the schema before this field.
    coSignerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    milestones: { type: [MilestoneSchema], default: [] },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

ProjectSchema.index({ projectType: 1, status: 1 });
ProjectSchema.index({ ownerId: 1 });
ProjectSchema.index({ 'location.lat': 1, 'location.lng': 1 });

module.exports = model('Project', ProjectSchema);
