const { z } = require('zod');

const createSubscription = z.object({
  planType: z.enum(['pro_contractor', 'power_funder']),
  renewalDate: z.coerce.date().optional(),
});

module.exports = { createSubscription };
