const { Schema, model } = require('mongoose');

// One flexible key/value row per spec (grade, diameter, color, ...) — an
// array of subdocs, not a dynamic-keyed object, so it validates predictably
// and renders as ordered rows in the frontend's editor.
const SpecificationSchema = new Schema({ key: { type: String, required: true }, value: { type: String, required: true } }, { _id: false });

const DimensionsSchema = new Schema(
  {
    length: { type: Number, default: null, min: 0 },
    width: { type: Number, default: null, min: 0 },
    height: { type: Number, default: null, min: 0 },
    unit: { type: String, default: 'cm' },
    weightKg: { type: Number, default: null, min: 0 },
  },
  { _id: false }
);

const SupplierSchema = new Schema({ name: { type: String, default: '' }, contact: { type: String, default: '' } }, { _id: false });

/** A quincaillerie's own product catalogue — real backend now (was
 * materials.tsx's local useState mock). category/subcategory/unit are free
 * strings, not enums, on purpose: the frontend ships a curated default
 * taxonomy as suggestions, but an owner can type anything new and it
 * persists exactly as typed — "extensible" per the product ask, matching
 * Project.category/ContractorProfile.categories' existing "let the market
 * define the list" convention rather than a fixed enum anywhere in this
 * schema. status is the archive/restore switch; a real DELETE removes the
 * document entirely (see controller) rather than a third status value. */
const InventoryItemSchema = new Schema(
  {
    quincaillerieId: { type: Schema.Types.ObjectId, ref: 'QuincaillerieProfile', required: true },
    name: { type: String, required: true },
    sku: { type: String, default: '' },
    category: { type: String, required: true },
    subcategory: { type: String, default: '' },
    description: { type: String, default: '' },
    images: { type: [String], default: [] },
    unit: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    quantityAvailable: { type: Number, required: true, min: 0, default: 0 },
    minStockLevel: { type: Number, required: true, min: 0, default: 0 },
    brand: { type: String, default: '' },
    supplier: { type: SupplierSchema, default: () => ({}) },
    specifications: { type: [SpecificationSchema], default: [] },
    dimensions: { type: DimensionsSchema, default: () => ({}) },
    // Subset of the platform's project categories (Water & Sanitation,
    // Education, Healthcare, Infrastructure, Agriculture, Housing) this
    // product is suited for — lets a funder/recipient filter a store's
    // catalogue by what their specific project actually needs.
    projectSuitability: { type: [String], default: [] },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  },
  { timestamps: true }
);

InventoryItemSchema.index({ quincaillerieId: 1, status: 1 });
InventoryItemSchema.index({ quincaillerieId: 1, category: 1 });
InventoryItemSchema.index({ name: 'text', sku: 'text', description: 'text', brand: 'text' });

module.exports = model('InventoryItem', InventoryItemSchema);
