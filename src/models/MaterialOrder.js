const { Schema, model } = require('mongoose');

const MaterialOrderItemSchema = new Schema(
  {
    // Null when hand-typed rather than picked from the store's own catalog
    // (matches InventoryItem's optional-reference convention elsewhere).
    inventoryItemId: { type: Schema.Types.ObjectId, ref: 'InventoryItem', default: null },
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    subtotal: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

/** A funder's or contractor's request for materials on a specific project
 * milestone, fulfilled by a specific supplier — the real backend for what
 * used to be materials.tsx's local-only MaterialOrder mock. Links four real
 * relationships in one document: the project, the exact milestone within
 * it, the fulfilling SupplierProfile, and the User who asked for it — every
 * one of them a real ObjectId ref, not a display string. */
const MaterialOrderSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    // Project.milestones is an array of subdocuments, not its own
    // collection — this is that subdocument's _id, resolved/validated
    // against the parent Project in the controller, not a separate ref.
    milestoneId: { type: Schema.Types.ObjectId, required: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'SupplierProfile', required: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    items: { type: [MaterialOrderItemSchema], default: [] },
    totalAmount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['requested', 'confirmed', 'rejected', 'out_for_delivery', 'delivered', 'cancelled'],
      default: 'requested',
    },
    rejectionReason: { type: String, default: '' },
    deliveryAddress: { type: String, default: '' },
    estimatedDeliveryDate: { type: Date, default: null },
    // Set once the requester (or another real project party physically on
    // site) confirms the materials actually arrived — same geotag-backed
    // "proof, not just a status flip" convention milestone evidence uses.
    deliveryConfirmation: {
      geotag: {
        lat: { type: Number, default: null },
        lng: { type: Number, default: null },
      },
      timestamp: { type: Date, default: null },
      confirmedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    },
    confirmedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

MaterialOrderSchema.index({ milestoneId: 1 });
MaterialOrderSchema.index({ supplierId: 1, status: 1 });
MaterialOrderSchema.index({ projectId: 1 });

module.exports = model('MaterialOrder', MaterialOrderSchema);
