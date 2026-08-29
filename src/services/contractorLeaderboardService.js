const { User, ContractorProfile } = require('../models');
const { getStats } = require('./contractorStatsService');
const { getVerifiedCertCounts } = require('./contractorMatchingService');

// Same "weighted total + auditable breakdown, named thresholds, batch-loaded
// data, neutral (not zero) credit for new/thin accounts" convention as
// contractorMatchingService.scoreContractor / verifierMatchingService.
// scoreVerifier — but project-independent: there's no tender to match
// against here, so category/location dimensions don't apply. The four
// dimensions below map directly onto what a public leaderboard was actually
// asked to rank on: completed projects, ratings, reliability, and verified
// experience.
const COMPLETED_PROJECTS_WEIGHT = 25;
const RATING_WEIGHT = 25;
const RELIABILITY_WEIGHT = 20;
const EXPERIENCE_WEIGHT = 15; // half of the 30-pt "verified experience" dimension
const VERIFIED_WEIGHT = 15; // other half — KYC + verified certifications

const COMPLETED_PROJECTS_FULL_CREDIT = 15; // 15+ completed projects: full marks, linear ramp below
const EXPERIENCE_FULL_CREDIT_YEARS = 10;
const CERTIFICATIONS_FULL_CREDIT_COUNT = 2;

/** Pure scoring function — everything it needs is passed in, so callers
 * batch-load profiles/stats/cert-counts once for the whole candidate pool
 * (never N+1 queries), same as getRecommendedContractors. */
function scoreForLeaderboard(profile, stats, verifiedCertCount, kycVerified) {
  const completedProjects = Math.round(Math.min(1, (stats.completedProjects || 0) / COMPLETED_PROJECTS_FULL_CREDIT) * COMPLETED_PROJECTS_WEIGHT);

  // A contractor with zero ratings yet gets a neutral half-credit rather
  // than zero — brand-new isn't the same as unrated-because-unreliable.
  const rating = stats.ratingCount > 0 ? Math.round(((stats.avgRating || 0) / 5) * RATING_WEIGHT) : Math.round(RATING_WEIGHT * 0.5);

  // Same neutral treatment for reliability — no accepted bids yet means no
  // completion-rate signal exists, not that it's zero.
  const reliability = stats.acceptedBids > 0 ? Math.round(stats.completionRate * RELIABILITY_WEIGHT) : Math.round(RELIABILITY_WEIGHT * 0.5);

  const yearsExperience = profile?.yearsExperience || 0;
  const experience = Math.round(Math.min(1, yearsExperience / EXPERIENCE_FULL_CREDIT_YEARS) * EXPERIENCE_WEIGHT);

  // "Verified experience" — split evenly between admin-verified
  // certifications and a flat KYC-verified bonus, since both are
  // independent signals of the same underlying idea (someone/something
  // outside the contractor's own say-so vouched for them).
  const certCredit = Math.min(1, verifiedCertCount / CERTIFICATIONS_FULL_CREDIT_COUNT) * (VERIFIED_WEIGHT / 2);
  const kycCredit = kycVerified ? VERIFIED_WEIGHT / 2 : 0;
  const verified = Math.round(certCredit + kycCredit);

  const total = completedProjects + rating + reliability + experience + verified;
  return { total, breakdown: { completedProjects, rating, reliability, experience, verified } };
}

/** Ranks every contractor on the platform (optionally filtered by category/
 * region/search first, same as contractorProfileController.getAll), scores
 * them all, sorts desc by total, then paginates the sorted array — the same
 * "load the filtered candidate pool once, score in application code" shape
 * getRecommendedContractors already uses for per-tender matching, since the
 * score can't be computed as a Mongo-side sort. */
async function getLeaderboard({ search, category, region, verified, page = 1, limit = 20 } = {}) {
  const userFilter = { 'roles.roleType': 'contractor' };
  const andClauses = [];

  if (category || region) {
    const profileFilter = {};
    if (category) profileFilter.categories = category;
    if (region) profileFilter.regions = region;
    const matching = await ContractorProfile.find(profileFilter).select('userId').lean();
    andClauses.push({ _id: { $in: matching.map((p) => p.userId) } });
  }
  // A funder searching by name doesn't know a contractor's exact fullName
  // string match — this also matches skills (categories), location
  // (regions), and the headline/bio/services free text a contractor wrote
  // about themselves, so "plumbing" or "Douala" finds real candidates even
  // when their name doesn't mention either.
  if (search) {
    const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    const matchingProfiles = await ContractorProfile.find({
      $or: [{ categories: pattern }, { regions: pattern }, { headline: pattern }, { services: pattern }, { bio: pattern }],
    }).select('userId').lean();
    andClauses.push({ $or: [{ fullName: pattern }, { _id: { $in: matchingProfiles.map((p) => p.userId) } }] });
  }
  // Optional KYC-verified filter — undefined (the default, used by every
  // current caller including the leaderboard screen and the funder-facing
  // TenderBidsScreen search) means no filter at all, showing every
  // contractor regardless of verification status; each result still carries
  // its own kycStatus so the caller can badge verified ones individually.
  if (verified !== undefined) userFilter.kycStatus = verified ? 'verified' : { $ne: 'verified' };

  if (andClauses.length > 0) userFilter.$and = andClauses;

  const users = await User.find(userFilter).select('fullName avatarUrl kycStatus').lean();
  if (users.length === 0) return { items: [], total: 0 };

  const userIds = users.map((u) => u._id);
  const profiles = await ContractorProfile.find({ userId: { $in: userIds } }).lean();
  const profileByUserId = new Map(profiles.map((p) => [String(p.userId), p]));
  const statsList = await Promise.all(userIds.map((id) => getStats(id)));
  const statsByUserId = new Map(userIds.map((id, i) => [String(id), statsList[i]]));
  const certCountByUserId = await getVerifiedCertCounts(userIds);

  const scored = users.map((user) => {
    const profile = profileByUserId.get(String(user._id)) || null;
    const stats = statsByUserId.get(String(user._id));
    const certCount = certCountByUserId.get(String(user._id)) || 0;
    const score = scoreForLeaderboard(profile, stats, certCount, user.kycStatus === 'verified');
    return {
      userId: user._id,
      fullName: user.fullName,
      avatarUrl: user.avatarUrl,
      kycStatus: user.kycStatus,
      categories: profile?.categories || [],
      regions: profile?.regions || [],
      yearsExperience: profile?.yearsExperience || 0,
      stats,
      score,
    };
  });

  // Tie-break by rating count then completed projects — a higher-volume,
  // more-reviewed contractor with the same rounded score should still rank
  // above a thinner track record at the same score.
  scored.sort((a, b) => b.score.total - a.score.total || b.stats.ratingCount - a.stats.ratingCount || b.stats.completedProjects - a.stats.completedProjects);

  const total = scored.length;
  const start = (page - 1) * limit;
  const items = scored.slice(start, start + limit).map((row, i) => ({ rank: start + i + 1, ...row }));
  return { items, total };
}

module.exports = { scoreForLeaderboard, getLeaderboard };
