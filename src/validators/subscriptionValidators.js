const { z } = require('zod');

const createSubscription = z.object({
  planType: z.enum(['pro_contractor', 'power_funder']),
  paymentProvider: z.enum(['mtn_momo', 'orange_money', 'flutterwave', 'stripe']),
  payerPhoneNumber: z.string().min(6).optional(),
});

module.exports = { createSubscription };
