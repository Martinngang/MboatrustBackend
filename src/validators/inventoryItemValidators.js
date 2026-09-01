const { z } = require('zod');

// multipart/form-data (images attached) can only carry string fields — this
// accepts either a real array/object (plain JSON request, no images) or a
// JSON-encoded string (multipart request), same convention as
// verifierProfileValidators.js's stringArray.
function jsonField(schema) {
  return z.preprocess((val) => {
    if (typeof val === 'string') {
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    }
    return val;
  }, schema);
}

const specificationSchema = z.object({ key: z.string().min(1), value: z.string().min(1) });
const dimensionsSchema = z.object({
  length: z.number().nullable().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  unit: z.string().optional(),
  weightKg: z.number().nullable().optional(),
});
const sourcedFromSchema = z.object({ name: z.string().optional(), contact: z.string().optional() });

const createItem = z.object({
  name: z.string().min(1),
  sku: z.string().optional(),
  category: z.string().min(1),
  subcategory: z.string().optional(),
  description: z.string().optional(),
  // URLs already uploaded elsewhere (rare) — the common case is the `images`
  // files field the multer middleware parses separately.
  existingImages: jsonField(z.array(z.string())).optional(),
  unit: z.string().min(1),
  price: z.coerce.number().min(0),
  quantityAvailable: z.coerce.number().min(0).optional(),
  minStockLevel: z.coerce.number().min(0).optional(),
  brand: z.string().optional(),
  sourcedFrom: jsonField(sourcedFromSchema).optional(),
  specifications: jsonField(z.array(specificationSchema)).optional(),
  dimensions: jsonField(dimensionsSchema).optional(),
  projectSuitability: jsonField(z.array(z.string())).optional(),
});

const updateItem = createItem.partial();

const bulkAction = z.object({
  ids: z.array(z.string()).min(1),
  action: z.enum(['archive', 'restore', 'delete']),
});

module.exports = { createItem, updateItem, bulkAction };
