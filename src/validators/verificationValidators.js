const { z } = require('zod');
const { objectId } = require('./common');

const createVerificationTask = z.object({
  targetType: z.enum(['milestone', 'land_listing']),
  targetId: objectId,
  verifierId: objectId,
});

const submitVerificationReport = z.object({
  reportText: z.string().min(1),
  reportPhotos: z.array(z.string().url()).optional().default([]),
  confirmedMatch: z.boolean(),
});

module.exports = { createVerificationTask, submitVerificationReport };
