const { z } = require('zod');
const { objectId } = require('./common');

const createConversation = z.object({
  contextType: z.enum(['project', 'bid', 'land_listing']),
  contextId: objectId,
  participantIds: z.array(objectId).min(1),
});

const sendMessage = z.object({
  body: z.string().optional().default(''),
  attachmentUrl: z.string().url().optional(),
});

module.exports = { createConversation, sendMessage };
