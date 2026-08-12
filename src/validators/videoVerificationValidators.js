const { z } = require('zod');

const requestSession = z.object({
  projectId: z.string().min(1),
  milestoneId: z.string().min(1),
  notes: z.string().optional(),
});

const scheduleSession = z.object({
  scheduledFor: z.coerce.date(),
  meetingUrl: z.string().url(),
});

const completeSession = z.object({
  notes: z.string().optional(),
});

module.exports = { requestSession, scheduleSession, completeSession };
