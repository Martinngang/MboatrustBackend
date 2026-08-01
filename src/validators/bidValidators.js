const { z } = require('zod');
const { objectId } = require('./common');

const createBid = z.object({
  projectId: objectId,
  price: z.number().min(0),
  timelineDays: z.number().int().min(1),
  materialsPlan: z.string().optional().default(''),
  notes: z.string().optional().default(''),
});

const updateBidStatus = z.object({
  status: z.enum(['accepted', 'rejected', 'withdrawn']),
});

module.exports = { createBid, updateBidStatus };
