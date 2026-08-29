const { z } = require('zod');

const adminCreateContract = z.object({
  projectId: z.string().min(1),
  bidId: z.string().min(1),
  generatedDocumentText: z.string().optional(),
  generatedDocumentUrl: z.string().url().optional(),
  status: z.enum(['active', 'completed', 'terminated']).optional(),
});

const adminUpdateContract = z.object({
  generatedDocumentText: z.string().optional(),
  generatedDocumentUrl: z.string().url().optional(),
  status: z.enum(['active', 'completed', 'terminated']).optional(),
});

module.exports = { adminCreateContract, adminUpdateContract };
