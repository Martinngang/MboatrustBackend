const { z } = require('zod');
const { objectId } = require('./common');

const createDispute = z.object({
  projectId: objectId,
  milestoneId: objectId.optional(),
  reason: z.string().min(1),
});

const resolveDispute = z.object({
  status: z.enum(['under_review', 'resolved', 'rejected']),
  resolutionNotes: z.string().optional().default(''),
});

module.exports = { createDispute, resolveDispute };
