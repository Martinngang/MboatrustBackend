const { z } = require('zod');

// Admin manual entry — e.g. recording an off-platform payment or fixing a
// missing ledger row. `reason` is required (not stored on the model itself,
// just recorded in the AdminActionLog detail) since this is a direct write
// to the platform's real money ledger.
const adminCreateEscrow = z.object({
  projectId: z.string().min(1),
  milestoneId: z.string().optional(),
  contractorId: z.string().optional(),
  funderId: z.string().optional(),
  type: z.enum(['fund', 'release', 'refund', 'fee_deduction']),
  grossAmount: z.number().min(0),
  netAmount: z.number().min(0),
  currency: z.string().min(1).optional(),
  paymentProvider: z.enum(['mtn_momo', 'orange_money', 'flutterwave', 'stripe']),
  providerRole: z.enum(['collection', 'disbursement']),
  providerReference: z.string().optional(),
  status: z.enum(['pending', 'completed', 'failed', 'reversed']).optional(),
  reason: z.string().min(1),
});

// Deliberately excludes projectId/milestoneId/type/contractorId/funderId —
// those are identity/linkage fields; changing which project or party money
// belongs to isn't an "edit", it's a different transaction (delete +
// recreate covers that instead).
const adminUpdateEscrow = z.object({
  status: z.enum(['pending', 'completed', 'failed', 'reversed']).optional(),
  grossAmount: z.number().min(0).optional(),
  netAmount: z.number().min(0).optional(),
  currency: z.string().min(1).optional(),
  providerReference: z.string().optional(),
  reason: z.string().min(1),
});

const adminDeleteEscrow = z.object({
  reason: z.string().min(1),
});

module.exports = { adminCreateEscrow, adminUpdateEscrow, adminDeleteEscrow };
