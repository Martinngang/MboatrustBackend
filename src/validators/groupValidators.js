const { z } = require('zod');

const createGroup = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  purpose: z.string().optional(),
  linkedProjectId: z.string().optional(),
});

const inviteMember = z.object({
  userId: z.string().min(1),
});

module.exports = { createGroup, inviteMember };
