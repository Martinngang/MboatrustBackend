const { z } = require('zod');

const invite = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  role: z.enum(['approver', 'viewer']).default('viewer'),
  permissions: z.array(z.enum(['submit_milestones'])).optional(),
});

const updateRole = z
  .object({
    role: z.enum(['approver', 'viewer']).optional(),
    permissions: z.array(z.enum(['submit_milestones'])).optional(),
  })
  .refine((data) => data.role !== undefined || data.permissions !== undefined, {
    message: 'Provide role and/or permissions',
  });

module.exports = { invite, updateRole };
