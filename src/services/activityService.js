const { Project, Bid, LandListing, Escrow, Dispute } = require('../models');

/**
 * A user's own activity feed, derived entirely from ground truth — no
 * separate "Activity" log collection to write to and keep in sync. Every
 * entry here is read straight off the real document (Project, Bid,
 * LandListing, Escrow, Dispute) that the action actually created, scoped to
 * this user via whichever field genuinely identifies them as the actor
 * (owner, contractor, seller, raisedBy, milestone approver/evidence
 * submitter) — never a global or cross-user feed. Amounts are returned raw
 * (not pre-formatted) so the frontend composes display text with its own
 * `fmt()`, the same convention every other endpoint in this API follows.
 */
async function getRecentActivity(userId, { limit = 50 } = {}) {
  const [ownedProjects, myBids, myListings] = await Promise.all([
    Project.find({ ownerId: userId }).select('_id projectType title currency milestones createdAt').lean(),
    Bid.find({ contractorId: userId }).select('_id projectId price createdAt').populate('projectId', 'title').lean(),
    LandListing.find({ sellerId: userId }).select('_id title createdAt').lean(),
  ]);
  const ownedProjectIds = ownedProjects.map((p) => p._id);

  const [fundEscrows, myDisputes] = await Promise.all([
    Escrow.find({ type: 'fund', projectId: { $in: ownedProjectIds }, status: 'completed' })
      .select('_id projectId netAmount currency createdAt')
      .lean(),
    Dispute.find({ raisedBy: userId }).select('_id projectId reason createdAt').populate('projectId', 'title').lean(),
  ]);

  const events = [];

  for (const p of ownedProjects) {
    const isTender = p.projectType === 'tender';
    events.push({
      type: 'project_created',
      path: isTender ? `/contractor/job/${p._id}` : `/funder/project/${p._id}`,
      createdAt: p.createdAt,
      projectTitle: p.title,
    });

    for (const m of p.milestones || []) {
      for (const e of m.evidence || []) {
        if (String(e.submittedBy) === String(userId)) {
          events.push({
            type: 'milestone_submitted',
            path: '/recipient/submission-status',
            createdAt: e.createdAt,
            projectTitle: p.title,
            milestoneName: m.name,
          });
        }
      }
      for (const a of m.approvers || []) {
        if (String(a.userId) === String(userId) && a.status === 'approved' && a.decidedAt) {
          events.push({
            type: 'milestone_approved',
            path: `/funder/project/${p._id}`,
            createdAt: a.decidedAt,
            projectTitle: p.title,
            milestoneName: m.name,
            amount: m.amount,
            currency: p.currency,
          });
        }
      }
    }
  }

  for (const escrow of fundEscrows) {
    const project = ownedProjects.find((p) => String(p._id) === String(escrow.projectId));
    events.push({
      type: 'project_funded',
      path: project ? `/funder/project/${project._id}` : undefined,
      createdAt: escrow.createdAt,
      projectTitle: project?.title,
      amount: escrow.netAmount,
      currency: escrow.currency,
    });
  }

  for (const d of myDisputes) {
    const projectTitle = d.projectId && typeof d.projectId === 'object' ? d.projectId.title : undefined;
    const projectId = d.projectId && typeof d.projectId === 'object' ? d.projectId._id : d.projectId;
    events.push({
      type: 'milestone_disputed',
      path: projectId ? `/funder/project/${projectId}` : undefined,
      createdAt: d.createdAt,
      projectTitle,
      reason: d.reason,
    });
  }

  for (const b of myBids) {
    const projectTitle = b.projectId && typeof b.projectId === 'object' ? b.projectId.title : undefined;
    const projectId = b.projectId && typeof b.projectId === 'object' ? b.projectId._id : b.projectId;
    events.push({
      type: 'bid_placed',
      path: `/contractor/job/${projectId}`,
      createdAt: b.createdAt,
      projectTitle,
      amount: b.price,
      currency: 'XAF',
    });
  }

  for (const l of myListings) {
    events.push({
      type: 'listing_created',
      path: `/land/listing/${l._id}`,
      createdAt: l.createdAt,
      projectTitle: l.title,
    });
  }

  events.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return events.slice(0, limit);
}

module.exports = { getRecentActivity };
