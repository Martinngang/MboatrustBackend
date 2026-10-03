const { TeamMember } = require('../models');

/** Contractor ids of every contractor `userId` is an active
 * 'submit_milestones' team delegate for (see TeamMember.js) — empty for
 * everyone who isn't delegated to submit milestones on someone else's
 * behalf. Shared by bidController (its security scope and its contractorId
 * query handling) and dashboardStatsService, so all three agree on who
 * counts as "acting as" a given contractor. */
async function delegatedForIds(userId) {
  const rows = await TeamMember.find({ userId, status: 'active', permissions: 'submit_milestones' }).select('ownerId').lean();
  return rows.map((r) => r.ownerId);
}

module.exports = { delegatedForIds };
