const { z } = require('zod');

const invite = z.object({
  projectId: z.string().min(1),
  contributorId: z.string().min(1),
  amount: z.number().positive(),
  currency: z.enum(['USD', 'EUR', 'GBP', 'XAF']).optional(),
  isRecurring: z.boolean().optional().default(false),
  recurrenceIntervalDays: z.number().int().positive().optional(),
});

const contribute = z.object({
  contributionId: z.string().optional(),
  projectId: z.string().optional(),
  amount: z.number().positive().optional(),
  currency: z.enum(['USD', 'EUR', 'GBP', 'XAF']).optional(),
  isRecurring: z.boolean().optional().default(false),
  recurrenceIntervalDays: z.number().int().positive().optional(),
  paymentProvider: z.enum(['mtn_momo', 'orange_money', 'flutterwave', 'stripe']),
  payerPhoneNumber: z.string().min(6).optional(),
});

module.exports = { invite, contribute };
