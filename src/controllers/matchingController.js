const { Project, Bid, ContractorProfile } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { scoreContractor, getRecommendedContractors, getVerifiedCertCounts } = require('../services/contractorMatchingService');
const { getStats } = require('./contractorProfileController');
const { isAiConfigured, analyzeWithGemini, parseJsonResponse } = require('../services/aiClient');
const env = require('../config/env');

const AI_RATIONALE_TOP_N = 5;

/**
 * Adds a short "why this contractor" sentence to each of the top N
 * heuristic results — never reorders them and never adds a contractor the
 * heuristic engine didn't already shortlist, so the AI can only annotate,
 * not silently substitute its own judgment for the auditable score. Mutates
 * nothing on failure/timeout/no-config — every recommendation just keeps
 * `aiRationale: null`.
 */
async function attachAiRationale(project, recommendations) {
  for (const r of recommendations) r.aiRationale = null;
  if (!env.ai.matchingRationaleEnabled || !isAiConfigured() || recommendations.length === 0) return recommendations;

  const shortlist = recommendations.slice(0, AI_RATIONALE_TOP_N);
  const system =
    'You write short, specific "why this contractor fits" notes for a funder comparing pre-scored ' +
    'contractor candidates on Mboa Trust, a construction-escrow platform in Cameroon. You do not choose ' +
    'or re-rank candidates — a separate deterministic score already ranked them; you only explain the ' +
    'fit of each one already given to you, in the order given. Reply with strict JSON only, no prose, no ' +
    'markdown fences: {"rationales": [{"contractorId": "<id>", "text": "<one sentence>"}, ...]} — exactly ' +
    'one entry per candidate given, in the same order.';

  const prompt =
    `Tender: "${project.title}" — category: ${project.category || 'unspecified'}, ` +
    `location: ${project.locationName || 'unspecified'}\n` +
    `Description: ${project.description || 'none'}\n\n` +
    `Candidates (already ranked, do not reorder):\n` +
    shortlist
      .map(
        (r, i) =>
          `${i + 1}. contractorId=${r.contractorId} name=${r.fullName} score=${r.score.total}/100 ` +
          `(category match ${r.score.breakdown.category}/30, location ${r.score.breakdown.location}/15, ` +
          `experience ${r.score.breakdown.experience}/10, certifications ${r.score.breakdown.certifications}/10) ` +
          `completedProjects=${r.stats.completedProjects} avgRating=${r.stats.avgRating ?? 'none'} ` +
          `completionRate=${Math.round((r.stats.completionRate || 0) * 100)}%`
      )
      .join('\n');

  const result = await analyzeWithGemini({ system, prompt });
  if (!result.ok) return recommendations;

  const parsed = parseJsonResponse(result.text);
  if (!parsed || !Array.isArray(parsed.rationales)) return recommendations;

  const rationaleById = new Map(
    parsed.rationales
      .filter((r) => r && typeof r.contractorId === 'string' && typeof r.text === 'string')
      .map((r) => [r.contractorId, r.text.slice(0, 500)])
  );
  for (const r of shortlist) {
    const text = rationaleById.get(String(r.contractorId));
    if (text) r.aiRationale = text;
  }
  return recommendations;
}

function assertOwnerOrAdmin(project, user) {
  const isOwner = String(project.ownerId) === String(user._id);
  const isAdmin = user.roles?.some((r) => r.roleType === 'admin');
  if (!isOwner && !isAdmin) throw ApiError.forbidden('Only the project owner or an admin can view this');
}

const getRecommended = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.projectId);
  if (!project) throw ApiError.notFound('Project not found');
  assertOwnerOrAdmin(project, req.user);

  const recommendations = await getRecommendedContractors(project._id, {
    limit: Number(req.query.limit) || 10,
  });
  await attachAiRationale(project, recommendations);
  return ok(res, recommendations);
});

/** Real bidder data for a tender's "compare bids" view — every bid on the
 * project, populated with the bidder's profile and the same scoring
 * function used for pre-bid recommendations, so a funder sees a consistent
 * ranking whether they're browsing candidates or comparing bids already in hand. */
const getBidsWithScores = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.projectId).lean();
  if (!project) throw ApiError.notFound('Project not found');
  assertOwnerOrAdmin(project, req.user);

  const bids = await Bid.find({ projectId: project._id })
    .populate('contractorId', 'fullName avatarUrl')
    .sort('-createdAt')
    .lean();
  if (bids.length === 0) return ok(res, []);

  const contractorIds = bids.map((b) => b.contractorId._id);
  const profiles = await ContractorProfile.find({ userId: { $in: contractorIds } }).lean();
  const profileByUserId = new Map(profiles.map((p) => [String(p.userId), p]));
  const statsList = await Promise.all(contractorIds.map((id) => getStats(id)));
  const statsByUserId = new Map(contractorIds.map((id, i) => [String(id), statsList[i]]));
  const certCountByUserId = await getVerifiedCertCounts(contractorIds);

  const withScores = bids.map((bid) => {
    const profile = profileByUserId.get(String(bid.contractorId._id)) || null;
    const stats = statsByUserId.get(String(bid.contractorId._id));
    const certCount = certCountByUserId.get(String(bid.contractorId._id)) || 0;
    return { ...bid, score: scoreContractor(project, profile, stats, certCount), stats };
  });

  withScores.sort((a, b) => b.score.total - a.score.total);
  return ok(res, withScores);
});

module.exports = { getRecommended, getBidsWithScores, attachAiRationale };
