const { Schema, model } = require('mongoose');

/** Real backend counterpart to the frontend's former materials.tsx mock —
 * same field shapes, now with the application review state machine
 * VerifierProfile already established (supplier is trust-elevating the
 * same way verifier is: an admin must approve before the role lands, see
 * supplierProfileController.approve). Represents any construction-material
 * business — quincaillerie, sand, blocks, stone, cement, steel, timber,
 * roofing, plumbing/electrical, etc. — not just hardware stores. */
const SupplierProfileSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    businessName: { type: String, required: true },
    location: {
      lat: { type: Number, default: 0 },
      lng: { type: Number, default: 0 },
    },
    address: { type: String, default: '' },
    region: { type: String, required: true },
    // Free-form strings, not an enum — matches Project.category/
    // ContractorProfile.categories' existing "let the market define the
    // list" convention rather than a fixed taxonomy. This is how a supplier
    // expresses its business type/categories (quincaillerie, sand, blocks,
    // stone, cement, steel, timber, roofing, plumbing, electrical, etc.) —
    // the frontend's inventoryTaxonomy.ts category names are offered as
    // suggestions, but any free-text value is accepted.
    registeredCategories: { type: [String], default: [] },
    phone: { type: String, default: '' },
    paymentProvider: { type: String, enum: ['mtn_momo', 'orange_money'], default: 'mtn_momo' },
    payoutPhoneNumber: { type: String, default: '' },
    verificationDocUploaded: { type: Boolean, default: false },
    applicationStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    averageRating: { type: Number, default: 0 },
    completedOrderCount: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

SupplierProfileSchema.index({ applicationStatus: 1 });
SupplierProfileSchema.index({ region: 1 });

// Pins the physical collection name to the pre-existing
// 'quincaillerieprofiles' collection — this is a pure code-level rename
// (model/role naming only), not a data migration, so no document ever
// moves and there's zero risk of a partial/failed collection rename.
module.exports = model('SupplierProfile', SupplierProfileSchema, 'quincaillerieprofiles');
