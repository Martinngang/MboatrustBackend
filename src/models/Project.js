const { Schema, model } = require('mongoose');

// Shared by every {lat,lng} location field on this and other models
// (LandListing, VerifierProfile, VerificationTask.confirmedLocation) — added
// as a SIBLING field next to the existing lat/lng, never replacing it, so
// every pre-existing `.lat`/`.lng` reader keeps working unchanged. See
// services/locationDetailsService.js, the one place that populates this.
const LocationDetailsSchema = new Schema(
  {
    placeName: { type: String, default: '' },
    formattedAddress: { type: String, default: '' },
    source: {
      type: String,
      enum: ['manual_pin', 'gps', 'geocoded_search', 'auto_detected', 'verifier_confirmed'],
      default: 'manual_pin',
    },
    resolvedAt: { type: Date, default: null },
  },
  { _id: false }
);

// A real Schema type (not a plain nested {lat,lng} path like `location`
// above) specifically so `default: undefined` actually works — Mongoose
// auto-vivifies plain nested paths with their leaf defaults regardless of
// what the parent's own default says, which would make an "already
// snapshotted?" check on locationBeforeVerification always see a truthy
// {lat:null,lng:null} object and never fire. A real SchemaType subdocument,
// by contrast, genuinely stays `undefined` until explicitly assigned.
const GeoPointSchema = new Schema({ lat: { type: Number, default: null }, lng: { type: Number, default: null } }, { _id: false });

const EvidenceSchema = new Schema(
  {
    type: { type: String, enum: ['photo', 'video'], required: true },
    fileUrl: { type: String, required: true },
    notes: { type: String, default: '', trim: true },
    geotag: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    // Short, human-readable place name for `geotag` ("Bonabéri, Douala,
    // Littoral Region"), resolved once at submission time (see
    // projectController.submitEvidence + services/geocodingService) and
    // persisted here so every later viewer (funder reviewing evidence,
    // the contractor themselves) reads the same resolved name instead of
    // raw coordinates or re-geocoding on every view.
    placeName: { type: String, default: null },
    // Full geocoder address string alongside the short placeName above, and
    // the capture method — 'gps' for a live device fix, 'auto_detected' for
    // a client that resolved it some other way before submitting.
    formattedAddress: { type: String, default: '' },
    source: { type: String, enum: ['gps', 'auto_detected'], default: 'gps' },
    // How the FILE ITSELF was obtained — distinct from `source` above, which
    // is only about where the geotag came from. 'ar_camera' is a live,
    // on-device capture through the in-app HUD-overlay camera (see
    // components/ARCameraCapture on both frontends); 'gallery_upload' is any
    // pre-existing file picked from the device/browser file picker. Lets a
    // reviewer tell "taken live on-site, just now" apart from "an existing
    // photo, could be old or from anywhere."
    captureSource: { type: String, enum: ['ar_camera', 'gallery_upload'], default: 'gallery_upload' },
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

const ChangeRequestSchema = new Schema(
  {
    reason: { type: String, required: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    requestedAt: { type: Date, default: Date.now },
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
    // Optional — where THIS milestone's work happens, distinct from the
    // project's overall `location` (a large/multi-site project may have
    // different milestones at different points, e.g. a borehole at the
    // north plot vs a pump house at the south plot). Null means "use the
    // project's location" everywhere this is displayed. Also sharpens
    // evidenceAnalysisService's fraud-check geotag comparison when set —
    // see submitEvidence.
    location: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    locationDetails: { type: LocationDetailsSchema, default: () => ({}) },
    evidence: { type: [EvidenceSchema], default: [] },
    approvers: { type: [ApproverSchema], default: [] },
    // A lighter-weight, resubmittable alternative to a formal Dispute — the
    // project owner sends the milestone back to 'pending' with a reason
    // instead of escalating. Full history kept (not just the latest one) so
    // both parties can see every round of back-and-forth on this milestone.
    changeRequests: { type: [ChangeRequestSchema], default: [] },
    // Set when the contractor explicitly accepts the risk of working on this
    // milestone without full escrow cover ("Proceed Without Full Escrow" —
    // see projectController.proceedAtRisk). It is only a gate override: it
    // never counts as funding, release, or a payment guarantee. The
    // immutable audit record lives in MilestoneRiskAcknowledgement.
    riskAcknowledgedAt: { type: Date, default: null },
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
    locationDetails: { type: LocationDetailsSchema, default: () => ({}) },
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
    // How the parties agreed escrow gets funded (negotiated on the bid, see
    // bidController.updateStatus): 'staged' (default) funds milestone by
    // milestone and only funded milestones can start; 'full_upfront' means no
    // milestone starts until the whole contract value is in escrow.
    fundingMode: { type: String, enum: ['staged', 'full_upfront'], default: 'staged' },
    requiresMultiSig: { type: Boolean, default: false },
    // The second required signer for requiresMultiSig / any milestone with
    // requiresCosigner — null until the owner adds one via POST
    // /projects/:id/co-signer. No pre-existing co-signer identity concept
    // existed anywhere in the schema before this field.
    coSignerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    // Funder's choice at creation time: 'contractor' (default, today's only
    // behavior — whoever does the work sources their own materials) or
    // 'supplier', which requires preferredSupplierId below and makes that
    // store the pre-selected supplier RequestMaterialsScreen offers for
    // every milestone on this project.
    materialsManagedBy: { type: String, enum: ['contractor', 'supplier'], default: 'contractor' },
    preferredSupplierId: { type: Schema.Types.ObjectId, ref: 'SupplierProfile', default: null },
    // The funder's stated supplier/material-sourcing need, shown publicly on
    // the tender so contractors know before they bid: 'none' (no supplier
    // involvement), 'have_supplier' (funder picked one — preferredSupplierId
    // is set, materialsManagedBy is 'supplier'), or 'need_supplier' (funder
    // still needs one sourced — nothing is auto-assigned; a supplier is only
    // ever attached when the funder explicitly selects one).
    supplierRequirement: { type: String, enum: ['none', 'have_supplier', 'need_supplier'], default: 'none' },
    milestones: { type: [MilestoneSchema], default: [] },

    // The funder's yes/no answer at creation time to "do you already have a
    // project plan?" — distinct from hasPlanDocument below: a funder can
    // answer "yes" and still not have finished uploading the file yet (the
    // upload is a follow-up multipart call, since POST /projects itself is
    // plain JSON).
    hasExistingPlan: { type: Boolean, default: false },
    // Cheap, always-public flag — safe to return from the ordinary public
    // GET /projects/:id response (unlike planDocument below), so a browsing
    // contractor can see "a plan exists" without the actual file riding
    // along for everyone.
    hasPlanDocument: { type: Boolean, default: false },
    // select:false — Mongoose excludes this from every ordinary find()/
    // findById() automatically, with zero changes needed to the existing
    // (currently fully public, unauthenticated) getOne/getAll. Only
    // projectController.getPlanDocument ever does .select('+planDocument'),
    // after checking the caller is the owner/admin/contractor/verifier.
    planDocument: {
      type: new Schema(
        {
          fileUrl: { type: String, required: true },
          fileName: { type: String, default: '' },
          mimeType: { type: String, default: '' },
          uploadedAt: { type: Date, default: Date.now },
        },
        { _id: false }
      ),
      select: false,
      default: undefined,
    },

    // Mirrors LandListing.verificationStatus's existing pattern — set when
    // the funder doesn't know the exact site coordinates and requests a
    // Verifier to go confirm them (see projectController.requestLocationVerification).
    locationVerificationStatus: {
      type: String,
      enum: ['not_requested', 'requested', 'confirmed'],
      default: 'not_requested',
    },
    // Convenience pointer to the VerificationTask handling the request —
    // same idea as coSignerId above, so the frontend can fetch task detail
    // directly without a separate targetType/targetId query.
    locationVerificationTaskId: { type: Schema.Types.ObjectId, ref: 'VerificationTask', default: null },
    // One-time snapshot of `location`/`locationDetails` taken the instant a
    // verifier's confirmed report is about to overwrite them (see
    // verificationController.submitReport) — set once, never touched again,
    // so the pre-verification value is never lost even though `location`
    // itself becomes the live, verifier-confirmed pin from then on. The rest
    // of the audit trail (who confirmed it, when) lives on the
    // VerificationTask document itself (verifierId + confirmedLocation(Details)
    // + updatedAt) — no separate audit collection needed.
    locationBeforeVerification: { type: GeoPointSchema, default: undefined },
    locationBeforeVerificationDetails: { type: LocationDetailsSchema, default: undefined },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

ProjectSchema.index({ projectType: 1, status: 1 });
ProjectSchema.index({ ownerId: 1 });
ProjectSchema.index({ 'location.lat': 1, 'location.lng': 1 });

const ProjectModel = model('Project', ProjectSchema);
module.exports = ProjectModel;
module.exports.LocationDetailsSchema = LocationDetailsSchema;
