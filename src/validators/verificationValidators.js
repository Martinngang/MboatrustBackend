const { z } = require('zod');
const { objectId, requiredGeoPoint, locationDetailsExtras } = require('./common');

const createVerificationTask = z.object({
  targetType: z.enum(['milestone', 'land_listing', 'project_location']),
  targetId: objectId,
  verifierId: objectId,
});

const submitVerificationReport = z.object({
  reportText: z.string().min(1),
  reportPhotos: z.array(z.string().url()).optional().default([]),
  confirmedMatch: z.boolean(),
  // Only meaningful for 'project_location' tasks — see VerificationTask.js.
  confirmedLocation: requiredGeoPoint.optional(),
  ...locationDetailsExtras,
});

module.exports = { createVerificationTask, submitVerificationReport };
