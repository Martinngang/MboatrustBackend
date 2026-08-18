const { z } = require('zod');

const upsertMine = z.object({
  specialties: z.array(z.string()).optional(),
  regions: z.array(z.string()).optional(),
  location: z.object({ lat: z.number(), lng: z.number() }).optional(),
  bio: z.string().optional(),
  isAvailable: z.boolean().optional(),
  // Accepted directly for the no-file/URL-only case — set server-side from
  // the uploaded file when one is attached (see controller, same pattern
  // as contractorCertificationController.create).
  idDocumentUrl: z.string().url().optional(),
});

module.exports = { upsertMine };
