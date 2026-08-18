const { z } = require('zod');

// multipart/form-data (when a file is attached, see routes.js's
// upload.single('file')) can only carry string fields — multer never
// parses JSON for you the way a plain `Content-Type: application/json`
// body does — so array fields arrive as a JSON-encoded string in that case.
// This accepts either shape rather than forcing the frontend to make two
// separate requests (metadata + file) just to keep the array typed.
const stringArray = z.preprocess((val) => {
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}, z.array(z.string()));

const upsertMine = z.object({
  specialties: stringArray.optional(),
  regions: stringArray.optional(),
  location: z.object({ lat: z.number(), lng: z.number() }).optional(),
  bio: z.string().optional(),
  isAvailable: z.coerce.boolean().optional(),
  // Accepted directly for the no-file/URL-only case — set server-side from
  // the uploaded file when one is attached (see controller, same pattern
  // as contractorCertificationController.create).
  idDocumentUrl: z.string().url().optional(),
});

module.exports = { upsertMine };
