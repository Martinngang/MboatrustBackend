const { z } = require('zod');

// multipart/form-data (portfolio images attached) can only carry string
// fields — this accepts either a real array (plain JSON request) or a
// JSON-encoded string (multipart request), same convention as
// verifierProfileValidators.js's stringArray / quincaillerieProfileValidators.js's jsonField.
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

const portfolioImageSchema = z.object({ url: z.string().url(), caption: z.string().optional() });

const upsertMine = z.object({
  categories: jsonField(z.array(z.string().min(1))).optional(),
  regions: jsonField(z.array(z.string().min(1))).optional(),
  location: jsonField(z.object({
    lat: z.number().nullable(),
    lng: z.number().nullable(),
  })).optional(),
  bio: z.string().max(2000).optional(),
  headline: z.string().max(140).optional(),
  services: jsonField(z.array(z.string().min(1))).optional(),
  // Existing portfolio images to keep (already-uploaded URLs, possibly with
  // an edited caption or reordered) — merged server-side with any newly
  // uploaded files in this same request. Never accepts raw `portfolioImages`
  // directly; that field is always computed, same convention as
  // InventoryItem's images/existingImages split.
  existingPortfolioImages: jsonField(z.array(portfolioImageSchema)).optional(),
  yearsExperience: z.coerce.number().min(0).max(80).optional(),
  isAvailable: z.coerce.boolean().optional(),
});

const setAvailability = z.object({
  dates: z.array(
    z.object({
      date: z.coerce.date(),
      isAvailable: z.boolean(),
    })
  ).min(1),
});

module.exports = { upsertMine, setAvailability };
