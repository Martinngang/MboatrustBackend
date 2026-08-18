const { Project, LandListing, User, VerifierProfile, VerificationTask } = require('../models');
const { haversineDistanceMeters } = require('../utils/geo');
const ApiError = require('../utils/ApiError');

const LOCATION_FULL_CREDIT_M = 20_000; // under 20km: full marks
const LOCATION_ZERO_CREDIT_M = 150_000; // 150km+: no marks, linear falloff between
const LOAD_FULL_CREDIT_TASKS = 0; // no open assignments: full marks
const LOAD_ZERO_CREDIT_TASKS = 5; // 5+ open assignments: no marks, linear falloff between

/** Resolves what a verification target actually is — its site location (for
 * proximity scoring) and, for milestones only, a project category to match
 * against a verifier's specialties. Land listings have no directly
 * comparable category field, so specialty scoring is neutral for them
 * rather than matching against something fabricated. */
async function resolveTargetForMatching(targetType, targetId) {
  if (targetType === 'land_listing') {
    const listing = await LandListing.findById(targetId).select('location').lean();
    if (!listing) return null;
    return { location: listing.location, category: null };
  }
  const project = await Project.findOne({ 'milestones._id': targetId }).select('location category').lean();
  if (!project) return null;
  return { location: project.location, category: project.category || null };
}

/** Weighted 0-100 composite score for how well one verifier fits one
 * verification target — same auditable-breakdown approach as
 * contractorMatchingService.scoreContractor, adapted to what actually
 * matters for an on-the-ground site visit: how close the verifier already
 * is, whether their declared specialty matches, and whether they're
 * carrying too much of an open caseload already to take on more. */
function scoreVerifier(target, verifierProfile, openTaskCount) {
  // Proximity (40 pts) — the dominant factor: a verifier physically has to
  // travel to the site, unlike a contractor who just needs to be biddable.
  let location = 0;
  const targetLoc = target.location;
  const verifierLoc = verifierProfile?.location;
  if (targetLoc?.lat != null && targetLoc?.lng != null && verifierLoc?.lat != null && verifierLoc?.lng != null) {
    const distance = haversineDistanceMeters(targetLoc, verifierLoc);
    if (distance <= LOCATION_FULL_CREDIT_M) location = 40;
    else if (distance >= LOCATION_ZERO_CREDIT_M) location = 0;
    else {
      const span = LOCATION_ZERO_CREDIT_M - LOCATION_FULL_CREDIT_M;
      location = Math.round(40 * (1 - (distance - LOCATION_FULL_CREDIT_M) / span));
    }
  } else if (verifierProfile?.regions?.length > 0) {
    // No coordinates on one side — coarser credit just for covering the
    // region at all, same fallback shape as contractor matching.
    location = 20;
  }

  // Specialty match (30 pts) — only meaningful for milestone targets, which
  // carry a real project category; land targets get neutral credit since
  // there's nothing comparable to match a specialty against.
  let specialty;
  if (target.category == null) {
    specialty = 15;
  } else if (!verifierProfile?.specialties || verifierProfile.specialties.length === 0) {
    specialty = 8;
  } else {
    const match = verifierProfile.specialties.some((s) => s.toLowerCase() === target.category.toLowerCase());
    specialty = match ? 30 : 0;
  }

  // Open caseload (20 pts) — fewer open assignments means more room to take
  // this one on soon rather than queuing behind existing work.
  let load;
  if (openTaskCount <= LOAD_FULL_CREDIT_TASKS) load = 20;
  else if (openTaskCount >= LOAD_ZERO_CREDIT_TASKS) load = 0;
  else load = Math.round(20 * (1 - openTaskCount / LOAD_ZERO_CREDIT_TASKS));

  // Availability (10 pts).
  const availability = verifierProfile?.isAvailable ? 10 : 0;

  const total = Math.round(location + specialty + load + availability);
  return { total, breakdown: { location, specialty, load, availability } };
}

/** Batch-counts each verifier's open (assigned or in_progress) tasks — one
 * query for every candidate rather than N. */
async function getOpenTaskCounts(verifierIds) {
  const rows = await VerificationTask.aggregate([
    { $match: { verifierId: { $in: verifierIds }, status: { $in: ['assigned', 'in_progress'] } } },
    { $group: { _id: '$verifierId', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.count]));
}

/** Ranks every approved verifier against one verification target. Only
 * approved applications are eligible — this feeds an admin assignment flow,
 * and a pending/rejected applicant has no business being suggested for real
 * work regardless of how well their profile would otherwise score. */
async function getRecommendedVerifiers(targetType, targetId, { limit = 10 } = {}) {
  const target = await resolveTargetForMatching(targetType, targetId);
  if (!target) throw ApiError.notFound('Verification target not found');

  const profiles = await VerifierProfile.find({ applicationStatus: 'approved' })
    .populate('userId', 'fullName avatarUrl')
    .lean();
  if (profiles.length === 0) return [];

  const verifierIds = profiles.map((p) => p.userId._id);
  const openTaskCountByVerifierId = await getOpenTaskCounts(verifierIds);

  const scored = profiles
    .filter((p) => p.userId) // guards against a dangling ref if a user was ever hard-deleted
    .map((profile) => {
      const openTaskCount = openTaskCountByVerifierId.get(String(profile.userId._id)) || 0;
      const score = scoreVerifier(target, profile, openTaskCount);
      return {
        verifierId: profile.userId._id,
        fullName: profile.userId.fullName,
        avatarUrl: profile.userId.avatarUrl,
        specialties: profile.specialties,
        regions: profile.regions,
        openTaskCount,
        score,
      };
    });

  scored.sort((a, b) => b.score.total - a.score.total);
  return scored.slice(0, limit);
}

module.exports = { scoreVerifier, getRecommendedVerifiers, resolveTargetForMatching };
