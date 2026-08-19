const mongoose = require('mongoose');
const {
  User, Project, Bid, Escrow, Contract, Dispute, ContractorProfile, ContractorCertification,
  LandListing, LandOffer, VisitRequest, NotificationPreference, Group, GroupMember,
  VerificationTask, VideoVerificationSession, Rating, RiskFlag, Conversation, Message,
  Notification, Referral, FeeConfig, Subscription, IdempotencyKey, TeamMember, ProjectTemplate,
  VerifierProfile, SystemEvent, PooledContribution,
} = require('../models');
const { initFirebase } = require('../config/firebase');

/**
 * True hard delete — irreversible, unlike deactivateMe's soft isActive
 * flip. The user explicitly chose "erase everything" over anonymization
 * after being told the tradeoff, so this really removes data rather than
 * scrubbing it in place. Scope, deliberately:
 *
 * - FULLY DELETED: everything solely owned/authored by this user with no
 *   other legitimate owner — their own profile records, listings, offers,
 *   disputes, ratings given AND received, messages, notifications, and
 *   every Project they OWN (cascaded through that project's own Escrow,
 *   Contract, Dispute, Bid, and PooledContribution rows, since those are
 *   scoped to a project that no longer exists once it's gone).
 * - DETACHED, NOT DELETED: places where this user appears inside someone
 *   ELSE's resource — a project they only co-signed or approved a
 *   milestone on, a bid they placed that was accepted into a real
 *   contract on someone else's tender, an escrow payout on a project they
 *   don't own. Deleting those would destroy a *different* real user's
 *   project/financial history, which "erase my data" doesn't require —
 *   the identity link is removed (nulled, pulled from an array, or left
 *   as a now-nonexistent id) while the other party's record stays intact.
 *   Every populate() call across this codebase already defensively falls
 *   back to "Unknown user" for a missing user reference, so a dangling id
 *   here degrades gracefully rather than crashing anything.
 * - The Firebase Auth identity itself is deleted (not just token-revoked
 *   the way deactivateMe does) — there is no reactivate path for this.
 */
async function hardDeleteUser(userId) {
  const uid = new mongoose.Types.ObjectId(userId);
  const user = await User.findById(uid);
  if (!user) return { deleted: false };

  const ownedProjects = await Project.find({ ownerId: uid }).select('_id milestones._id').lean();
  const ownedProjectIds = ownedProjects.map((p) => p._id);
  const ownedMilestoneIds = ownedProjects.flatMap((p) => (p.milestones || []).map((m) => m._id));

  const ownedListings = await LandListing.find({ sellerId: uid }).select('_id').lean();
  const ownedListingIds = ownedListings.map((l) => l._id);

  const createdGroups = await Group.find({ createdBy: uid }).select('_id').lean();
  const createdGroupIds = createdGroups.map((g) => g._id);

  // ── Cascade through projects/listings/groups this user OWNS ──────────
  if (ownedProjectIds.length > 0) {
    await Promise.all([
      Escrow.deleteMany({ projectId: { $in: ownedProjectIds } }),
      Contract.deleteMany({ projectId: { $in: ownedProjectIds } }),
      Dispute.deleteMany({ projectId: { $in: ownedProjectIds } }),
      Bid.deleteMany({ projectId: { $in: ownedProjectIds } }),
      PooledContribution.deleteMany({ projectId: { $in: ownedProjectIds } }),
    ]);
  }
  if (ownedMilestoneIds.length > 0) {
    await VerificationTask.deleteMany({ targetType: 'milestone', targetId: { $in: ownedMilestoneIds } });
  }
  if (ownedListingIds.length > 0) {
    await VerificationTask.deleteMany({ targetType: 'land_listing', targetId: { $in: ownedListingIds } });
  }
  if (createdGroupIds.length > 0) {
    await GroupMember.deleteMany({ groupId: { $in: createdGroupIds } });
    await Group.deleteMany({ _id: { $in: createdGroupIds } });
  }

  // ── Everything else solely theirs ─────────────────────────────────────
  await Promise.all([
    Project.deleteMany({ ownerId: uid }),
    LandListing.deleteMany({ sellerId: uid }),
    LandOffer.deleteMany({ buyerId: uid }),
    ContractorProfile.deleteOne({ userId: uid }),
    ContractorCertification.deleteMany({ userId: uid }),
    VerifierProfile.deleteOne({ userId: uid }),
    NotificationPreference.deleteOne({ userId: uid }),
    TeamMember.deleteMany({ $or: [{ ownerId: uid }, { userId: uid }] }),
    ProjectTemplate.deleteMany({ ownerId: uid }),
    VisitRequest.deleteMany({ requestedBy: uid }),
    VideoVerificationSession.deleteMany({ requestedBy: uid }),
    RiskFlag.deleteMany({ userId: uid }),
    SystemEvent.deleteMany({ userId: uid }),
    Notification.deleteMany({ userId: uid }),
    IdempotencyKey.deleteMany({ userId: uid }),
    Referral.deleteMany({ $or: [{ referrerId: uid }, { referredId: uid }] }),
    Dispute.deleteMany({ raisedBy: uid }),
    Rating.deleteMany({ $or: [{ fromUserId: uid }, { toUserId: uid }] }),
    Message.deleteMany({ senderId: uid }),
    GroupMember.deleteMany({ userId: uid }),
    VerificationTask.deleteMany({ verifierId: uid }),
    Subscription.deleteMany({ userId: uid }),
    // A pledge tracker toward someone else's project — the real money
    // movement it points at (escrowId -> Escrow) isn't touched here,
    // only this metadata row for their own pledge action.
    PooledContribution.deleteMany({ contributorId: uid, projectId: { $nin: ownedProjectIds } }),
  ]);

  // ── Bids they placed on OTHER people's projects: delete unless an
  // accepted-bid Contract already exists there (deleting that would
  // corrupt the other project owner's real hire/contract history) ──────
  const theirBidsElsewhere = await Bid.find({ contractorId: uid, projectId: { $nin: ownedProjectIds } }).select('_id').lean();
  const theirBidIds = theirBidsElsewhere.map((b) => b._id);
  if (theirBidIds.length > 0) {
    const contracted = await Contract.find({ bidId: { $in: theirBidIds } }).select('bidId').lean();
    const contractedBidIds = new Set(contracted.map((c) => String(c.bidId)));
    const deletableBidIds = theirBidIds.filter((id) => !contractedBidIds.has(String(id)));
    if (deletableBidIds.length > 0) await Bid.deleteMany({ _id: { $in: deletableBidIds } });
  }

  // ── Detach identity from records someone ELSE owns, without deleting
  // the record itself ───────────────────────────────────────────────────
  await Promise.all([
    Project.updateMany({ coSignerId: uid }, { $set: { coSignerId: null } }),
    Project.updateMany(
      { 'milestones.approvers.userId': uid },
      { $pull: { 'milestones.$[].approvers': { userId: uid } } }
    ),
    FeeConfig.updateMany({ updatedBy: uid }, { $set: { updatedBy: null } }),
    Escrow.updateMany({ contractorId: uid }, { $set: { contractorId: null } }),
    Conversation.updateMany({ participantIds: uid }, { $pull: { participantIds: uid } }),
  ]);
  // A conversation this user was the last/only participant of is dead weight.
  await Conversation.deleteMany({ participantIds: { $size: 0 } });

  // ── The account itself ────────────────────────────────────────────────
  const admin = initFirebase();
  if (user.firebaseUid && admin) {
    await admin.auth().deleteUser(user.firebaseUid).catch(() => {});
  }
  await User.deleteOne({ _id: uid });

  return { deleted: true };
}

module.exports = { hardDeleteUser };
