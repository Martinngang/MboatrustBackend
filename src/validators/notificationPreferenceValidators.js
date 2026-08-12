const { z } = require('zod');
const { CATEGORIES } = require('../utils/notificationCategories');

const channelPref = z.object({
  push: z.boolean().optional(),
  email: z.boolean().optional(),
});

// A partial map keyed by category — every key must be one of the six real
// categories, but not all six need to be present in one request.
const updatePrefs = z
  .record(z.enum(CATEGORIES), channelPref)
  .refine((obj) => Object.keys(obj).length > 0, { message: 'Provide at least one category to update' });

module.exports = { updatePrefs };
