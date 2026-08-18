const { z } = require('zod');

const createSystemEvent = z.object({
  type: z.string().min(1).max(100),
  source: z.string().min(1).max(100),
  detail: z.record(z.any()).optional().default({}),
});

module.exports = { createSystemEvent };
