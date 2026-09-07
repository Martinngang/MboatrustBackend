const { z } = require('zod');
const { SUPPORT_CATEGORIES } = require('../utils/supportCategories');
const { objectId } = require('./common');

const attachment = z.object({
  url: z.string().min(1),
  type: z.string().optional().default('file'),
  mimeType: z.string().optional().default(''),
  fileName: z.string().optional().default(''),
  sizeBytes: z.number().optional().default(0),
});

const context = z.object({
  platform: z.enum(['web', 'mobile']).optional(),
  screen: z.string().optional().default(''),
  screenLabel: z.string().optional().default(''),
  feature: z.string().optional().default(''),
  appVersion: z.string().optional().default(''),
});

const createSupportTicket = z.object({
  type: z.enum(['bug_report', 'feedback', 'question', 'contact_support']),
  category: z.enum(SUPPORT_CATEGORIES).optional().default('other'),
  subject: z.string().min(1),
  description: z.string().min(1),
  attachments: z.array(attachment).optional().default([]),
  context: context.optional(),
});

const addSupportTicketResponse = z.object({
  message: z.string().min(1),
});

const updateSupportTicketStatus = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'closed']),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
});

// `null` (not just a missing key) is the real "return this to the unassigned
// queue" signal, so it has to survive validation rather than be stripped.
const assignSupportTicket = z.object({
  assignedTo: objectId.nullable(),
});

module.exports = { createSupportTicket, addSupportTicketResponse, updateSupportTicketStatus, assignSupportTicket };
