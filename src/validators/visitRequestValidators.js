const { z } = require('zod');

const requestVisit = z.object({
  listingId: z.string().min(1),
  proposedDates: z.array(z.coerce.date()).min(1),
  notes: z.string().optional(),
});

const confirmVisit = z.object({
  confirmedDate: z.coerce.date(),
});

module.exports = { requestVisit, confirmVisit };
