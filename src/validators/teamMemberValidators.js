const { z } = require('zod');

const invite = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  role: z.enum(['approver', 'viewer']).default('viewer'),
});

const updateRole = z.object({
  role: z.enum(['approver', 'viewer']),
});

module.exports = { invite, updateRole };
