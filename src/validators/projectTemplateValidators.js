const { z } = require('zod');

const milestone = z.object({
  title: z.string().min(1),
  amount: z.number().min(0),
  description: z.string().optional(),
});

const create = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
  milestones: z.array(milestone).min(1),
});

module.exports = { create };
