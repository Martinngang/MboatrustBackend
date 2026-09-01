const { z } = require('zod');

const orderItemInput = z.object({
  inventoryItemId: z.string().optional().nullable(),
  name: z.string().min(1),
  quantity: z.number().min(1),
  unitPrice: z.number().min(0),
});

const createMaterialOrder = z.object({
  projectId: z.string(),
  milestoneId: z.string(),
  supplierId: z.string(),
  items: z.array(orderItemInput).min(1),
  deliveryAddress: z.string().optional().default(''),
});

// The supplier owner may adjust items/pricing when confirming (real
// stock/price at the time of confirmation can differ from what the
// requester guessed while browsing) — same "confirmation can correct the
// request" shape as a bid negotiation, not a rigid accept-as-is.
const confirmMaterialOrder = z.object({
  items: z.array(orderItemInput).optional(),
  deliveryAddress: z.string().optional(),
  estimatedDeliveryDate: z.coerce.date().optional(),
});

const rejectMaterialOrder = z.object({
  reason: z.string().min(1),
});

const confirmDelivery = z.object({
  geotagLat: z.coerce.number().min(-90).max(90).optional(),
  geotagLng: z.coerce.number().min(-180).max(180).optional(),
});

module.exports = { createMaterialOrder, confirmMaterialOrder, rejectMaterialOrder, confirmDelivery };
