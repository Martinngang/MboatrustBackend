const { z } = require('zod');
const { objectId } = require('./common');

// A contractor's (or funder's counter-) proposed payment schedule — its own
// small shape, not Project.milestones' (no status/evidence/approvers here,
// none of that exists until a bid is actually accepted and locked onto the
// project — see bidController.updateStatus).
const milestoneProposal = z.object({
  title: z.string().min(1),
  description: z.string().optional().default(''),
  amount: z.number().min(0),
});

// How escrow gets funded under a set of terms: 'staged' (default — milestone by
// milestone, only funded milestones can start) or 'full_upfront' (the whole
// contract value must be in escrow before any milestone starts). Negotiated
// per round; the accepted round's value becomes Project.fundingMode.
const fundingMode = z.enum(['staged', 'full_upfront']);

const createBid = z.object({
  projectId: objectId,
  price: z.number().min(0),
  timelineDays: z.number().int().min(1),
  materialsPlan: z.string().optional().default(''),
  notes: z.string().optional().default(''),
  // Optional — an empty/omitted schedule means "a lump-sum price, no
  // per-milestone breakdown proposed yet", today's original behavior.
  milestones: z.array(milestoneProposal).optional().default([]),
  fundingMode: fundingMode.optional().default('staged'),
});

const updateBidStatus = z.object({
  status: z.enum(['accepted', 'rejected', 'withdrawn']),
});

// Either real party (project owner or the bidder) appends a new round to an
// open negotiation — see bidController.counter. Same shape as createBid's
// negotiable fields, minus projectId (the bid already has one).
const counterBid = z.object({
  price: z.number().min(0),
  timelineDays: z.number().int().min(1),
  milestones: z.array(milestoneProposal).optional().default([]),
  message: z.string().optional().default(''),
  // Omitted = keep whatever the current terms already say.
  fundingMode: fundingMode.optional(),
});

module.exports = { createBid, updateBidStatus, counterBid, milestoneProposal };
