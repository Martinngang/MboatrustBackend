const { z } = require('zod');

const upsertFeeConfig = z.object({
  feeType: z.string().min(1),
  value: z.number().min(0),
  isFlat: z.boolean().optional().default(false),
});

module.exports = { upsertFeeConfig };
