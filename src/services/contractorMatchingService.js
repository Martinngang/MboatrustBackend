const { Project, User, ContractorProfile } = require('../models');
const { haversineDistanceMeters } = require('../utils/geo');
const { getStats } = require('../controllers/contractorProfileController');
const ApiError = require('../utils/ApiError');

const LOCATION_FULL_CREDIT_M = 20_000; // under 20km: full marks
const LOCATION_ZERO_CREDIT_M = 150_000; // 150km+: no marks, linear falloff between

/** Weighted 0-100 composite score for how well one contractor fits one
 * project/tender — deterministic and auditable (every point is traceable to
 * a `breakdown` field) rather than a black box, so a funder or admin can see
 * exactly why a contractor ranked where they did without needing AI. */
function scoreContractor(project, contractorProfile, stats) {
  const categories = contractorProfile?.categories || [];

  // Category match (35 pts) — full credit on a case-insensitive match;
  // don't zero out an unknown trade (empty categories), since a contractor
  // who hasn't filled in their profile yet isn't necessarily unqualified.
  let category;
  if (categories.length === 0) {
    category = 10;
  } else {
    const match = categories.some((c) => c.toLowerCase() === String(project.category || '').toLowerCase());
    category = match ? 35 : 0;
  }

  // Location proximity (20 pts) — real distance if both sides have
  // coordinates; a coarser region-name fallback otherwise; 0 if neither.
  let location = 0;
  const projLoc = project.location;
  const ctrLoc = contractorProfile?.location;
  if (projLoc?.lat != null && projLoc?.lng != null && ctrLoc?.lat != null && ctrLoc?.lng != null) {
    const distance = haversineDistanceMeters(projLoc, ctrLoc);
    if (distance <= LOCATION_FULL_CREDIT_M) location = 20;
    else if (distance >= LOCATION_ZERO_CREDIT_M) location = 0;
    else {
      const span = LOCATION_ZERO_CREDIT_M - LOCATION_FULL_CREDIT_M;
      location = Math.round(20 * (1 - (distance - LOCATION_FULL_CREDIT_M) / span));
    }
  } else if (contractorProfile?.regions?.length > 0 && project.locationName) {
    const nameLower = project.locationName.toLowerCase();
    const regionMatch = contractorProfile.regions.some((r) => nameLower.includes(r.toLowerCase()));
    location = regionMatch ? 12 : 0;
  }

  // Reliability (25 pts) — completion rate among accepted bids.
  const reliability = Math.round((stats.completionRate || 0) * 25);

  // Rating (15 pts) — a contractor with zero ratings gets a neutral half
  // credit rather than zero; brand-new isn't the same as unqualified.
  const rating = stats.ratingCount > 0 ? Math.round(((stats.avgRating || 0) / 5) * 15) : 7.5;

  // Availability (5 pts).
  const availability = contractorProfile?.isAvailable ? 5 : 0;

  const total = Math.round(category + location + reliability + rating + availability);

  return { total, breakdown: { category, location, reliability, rating, availability } };
}

/** Ranks every contractor against one project/tender. Batches the
 * ContractorProfile lookup (one query for all candidates) rather than
 * querying per-candidate, since this runs against the full contractor pool. */
async function getRecommendedContractors(projectId, { limit = 10 } = {}) {
  const project = await Project.findById(projectId).lean();
  if (!project) throw ApiError.notFound('Project not found');

  const contractorUsers = await User.find({ 'roles.roleType': 'contractor' })
    .select('fullName avatarUrl')
    .lean();
  if (contractorUsers.length === 0) return [];

  const userIds = contractorUsers.map((u) => u._id);
  const profiles = await ContractorProfile.find({ userId: { $in: userIds } }).lean();
  const profileByUserId = new Map(profiles.map((p) => [String(p.userId), p]));

  const statsList = await Promise.all(userIds.map((id) => getStats(id)));
  const statsByUserId = new Map(userIds.map((id, i) => [String(id), statsList[i]]));

  const scored = contractorUsers.map((user) => {
    const profile = profileByUserId.get(String(user._id)) || null;
    const stats = statsByUserId.get(String(user._id));
    const score = scoreContractor(project, profile, stats);
    return { contractorId: user._id, fullName: user.fullName, avatarUrl: user.avatarUrl, score, stats };
  });

  scored.sort((a, b) => b.score.total - a.score.total);
  return scored.slice(0, limit);
}

module.exports = { scoreContractor, getRecommendedContractors };
