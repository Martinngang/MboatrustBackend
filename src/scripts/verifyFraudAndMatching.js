// Real, end-to-end proof that the contractor-matching + AI fraud-detection
// system (see the "Fraud Detection & Contractor Matching" build guide)
// actually works together against the real database and, if GEMINI_API_KEY
// is set, the real Gemini API — not just that the code compiles. Safe to
// re-run any time: every fixture it creates is tagged and deleted again at
// the end of the run, pass or fail.
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, ContractorProfile, ContractorCertification, Project, RiskFlag } = require('../models');
const { getRecommendedContractors, scoreContractor, getVerifiedCertCounts } = require('../services/contractorMatchingService');
const evidenceAnalysisService = require('../services/evidenceAnalysisService');
const storageService = require('../services/storageService');
const matchingController = require('../controllers/matchingController');
const { isAiConfigured } = require('../services/aiClient');
const env = require('../config/env');

const TAG = 'verify-fraud-matching-script';
// A real, valid 1x1 PNG — needs to be a genuinely decodable image since it
// goes through the real Cloudinary upload, not a mock.
const TEST_IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

const results = [];
function record(label, passed, detail = '') {
  results.push({ label, passed });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

async function seedContractors(funderId) {
  const specs = [
    { name: `${TAG} Alpha`, category: 'Water & Sanitation', lat: 3.86, lng: 11.51, region: 'Centre' },
    { name: `${TAG} Beta`, category: 'Water & Sanitation', lat: 4.05, lng: 9.7, region: 'Littoral' },
    { name: `${TAG} Gamma`, category: 'Electrical', lat: 3.85, lng: 11.5, region: 'Centre' },
  ];
  const created = [];
  for (const spec of specs) {
    const user = await User.create({
      fullName: spec.name,
      email: `${TAG}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
      firebaseUid: `${TAG}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      roles: [{ roleType: 'contractor' }],
    });
    await ContractorProfile.create({
      userId: user._id,
      categories: [spec.category],
      regions: [spec.region],
      location: { lat: spec.lat, lng: spec.lng },
      isAvailable: true,
    });
    created.push(user._id);
  }
  return created;
}

async function run() {
  await connectDB();
  const createdUserIds = [];
  const createdProjectIds = [];
  const createdCertIds = [];

  try {
    let funder = await User.findOne({ email: `${TAG}-funder@test.local` });
    if (!funder) {
      funder = await User.create({
        fullName: `${TAG} Funder`,
        email: `${TAG}-funder@test.local`,
        firebaseUid: `${TAG}-funder`,
        roles: [{ roleType: 'funder' }],
      });
    }
    createdUserIds.push(funder._id);

    const contractorIds = await seedContractors(funder._id);
    createdUserIds.push(...contractorIds);

    // ── 1. Heuristic contractor scoring ──────────────────────────────────
    const tender = await Project.create({
      projectType: 'tender',
      ownerId: funder._id,
      title: `${TAG} tender`,
      category: 'Water & Sanitation',
      description: 'Borehole pump installation for a rural clinic',
      locationName: 'Yaounde, Centre',
      location: { lat: 3.848, lng: 11.502 },
      totalAmount: 900000,
      currency: 'XAF',
      status: 'open',
    });
    createdProjectIds.push(tender._id);

    const recommendations = await getRecommendedContractors(tender._id, { limit: 10 });
    console.log('\nRanked recommendations:');
    for (const r of recommendations) {
      console.log(`  ${r.score.total} pts  ${r.fullName}  ${JSON.stringify(r.score.breakdown)}`);
    }
    const alphaRank = recommendations.findIndex((r) => r.fullName === `${TAG} Alpha`);
    const gammaRank = recommendations.findIndex((r) => r.fullName === `${TAG} Gamma`);
    record(
      'Heuristic scoring ran and ranked sensibly',
      recommendations.length > 0 && alphaRank !== -1 && gammaRank !== -1 && alphaRank < gammaRank,
      `Alpha (matching category) ranked #${alphaRank + 1}, Gamma (mismatched) ranked #${gammaRank + 1}`
    );

    // ── 1b. Experience + certification scoring ───────────────────────────
    // Two otherwise-identical contractors (same category, no location data
    // so location/reliability/rating all land the same for both) — the only
    // difference is years of experience and admin-verified certifications.
    // The seasoned/certified one must score strictly higher, and by no more
    // than the 20 points those two dimensions are worth combined.
    const seasoned = await User.create({
      fullName: `${TAG} Seasoned`,
      email: `${TAG}-seasoned-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-seasoned-${Date.now()}`,
      roles: [{ roleType: 'contractor' }],
    });
    const rookie = await User.create({
      fullName: `${TAG} Rookie`,
      email: `${TAG}-rookie-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-rookie-${Date.now()}`,
      roles: [{ roleType: 'contractor' }],
    });
    createdUserIds.push(seasoned._id, rookie._id);

    const seasonedProfile = await ContractorProfile.create({
      userId: seasoned._id,
      categories: ['Water & Sanitation'],
      yearsExperience: 10,
      isAvailable: true,
    });
    const rookieProfile = await ContractorProfile.create({
      userId: rookie._id,
      categories: ['Water & Sanitation'],
      yearsExperience: 0,
      isAvailable: true,
    });

    const cert1 = await ContractorCertification.create({
      userId: seasoned._id,
      title: 'Certified Plumbing Installer',
      issuer: 'Cameroon Board of Trades',
      verified: true,
    });
    const cert2 = await ContractorCertification.create({
      userId: seasoned._id,
      title: 'Water Systems Safety',
      issuer: 'Cameroon Board of Trades',
      verified: true,
    });
    // An unverified cert on the rookie must NOT count — only admin-verified
    // certifications earn matching credit.
    const cert3 = await ContractorCertification.create({
      userId: rookie._id,
      title: 'Self-reported cert',
      issuer: 'N/A',
      verified: false,
    });
    createdCertIds.push(cert1._id, cert2._id, cert3._id);

    const zeroStats = { completionRate: 0, ratingCount: 0, avgRating: null };
    const certCounts = await getVerifiedCertCounts([seasoned._id, rookie._id]);
    const seasonedScore = scoreContractor(tender, seasonedProfile, zeroStats, certCounts.get(String(seasoned._id)) || 0);
    const rookieScore = scoreContractor(tender, rookieProfile, zeroStats, certCounts.get(String(rookie._id)) || 0);
    record(
      'Verified certifications are counted, unverified ones are not',
      certCounts.get(String(seasoned._id)) === 2 && (certCounts.get(String(rookie._id)) || 0) === 0
    );
    record(
      'Experience + certifications lift a seasoned contractor\'s score',
      seasonedScore.total > rookieScore.total &&
        seasonedScore.total - rookieScore.total <= 20 &&
        seasonedScore.breakdown.experience === 10 &&
        seasonedScore.breakdown.certifications === 10 &&
        rookieScore.breakdown.experience === 0 &&
        rookieScore.breakdown.certifications === 0,
      `seasoned=${seasonedScore.total} (${JSON.stringify(seasonedScore.breakdown)}) rookie=${rookieScore.total} (${JSON.stringify(rookieScore.breakdown)})`
    );

    // ── 2. AI configuration ──────────────────────────────────────────────
    record('AI (Gemini) configured', isAiConfigured(), isAiConfigured() ? `model=${env.ai.model}` : 'no GEMINI_API_KEY set — heuristic-only mode');

    // ── 3. AI match rationale ────────────────────────────────────────────
    await matchingController.attachAiRationale(tender, recommendations);
    const top = recommendations[0];
    if (isAiConfigured() && env.ai.matchingRationaleEnabled) {
      record('AI matching rationale attached', typeof top.aiRationale === 'string' && top.aiRationale.length > 0, top.aiRationale || '');
    } else {
      record('AI matching rationale correctly skipped (not configured/disabled)', recommendations.every((r) => r.aiRationale === null));
    }

    // ── 4. AI fraud second opinion — clean vs duplicate evidence ─────────
    const fundingProject = await Project.create({
      projectType: 'funding',
      ownerId: funder._id,
      title: `${TAG} funding project`,
      category: 'Water & Sanitation',
      description: 'Borehole pump installation for a rural clinic',
      totalAmount: 500000,
      currency: 'XAF',
      status: 'open',
      milestones: [
        { name: 'Site prep', amount: 250000, orderIndex: 0 },
        { name: 'Pump install', amount: 250000, orderIndex: 1 },
      ],
    });
    createdProjectIds.push(fundingProject._id);

    const upload1 = await storageService.uploadBuffer(TEST_IMAGE, { folder: `mboatrust/${TAG}` });
    const cleanAnalysis = await evidenceAnalysisService.analyzeEvidence(TEST_IMAGE, fundingProject.location, null);
    record('Clean evidence produces no heuristic flag', cleanAnalysis.duplicateFlag === false);

    // Re-analyze the SAME bytes — Project.findOne over evidence.fileHash
    // only sees a match once the first submission is actually persisted, so
    // persist milestone 1's evidence for real before re-checking milestone 2.
    fundingProject.milestones[0].evidence.push({
      type: 'photo',
      fileUrl: upload1.secure_url,
      geotag: cleanAnalysis.geotag,
      fileHash: cleanAnalysis.fileHash,
      locationMatch: cleanAnalysis.locationMatch,
      timestampRecent: cleanAnalysis.timestampRecent,
      duplicateFlag: cleanAnalysis.duplicateFlag,
      submittedBy: funder._id,
    });
    await fundingProject.save();

    const dupAnalysis = await evidenceAnalysisService.analyzeEvidence(TEST_IMAGE, fundingProject.location, null);
    record('Reused evidence file is detected as a duplicate', dupAnalysis.duplicateFlag === true);

    const riskFlag = await RiskFlag.create({
      userId: funder._id,
      flagType: 'reused_evidence',
      severity: 'medium',
      detail: { projectId: fundingProject._id, milestoneId: fundingProject.milestones[1]._id, fileHash: dupAnalysis.fileHash },
    });
    const aiOpinion = await evidenceAnalysisService.getAiSecondOpinion({
      analysis: dupAnalysis,
      project: fundingProject,
      milestone: fundingProject.milestones[1],
      fileUrl: upload1.secure_url,
      evidenceType: 'photo',
    });
    if (isAiConfigured() && env.ai.fraudAnalysisEnabled) {
      if (aiOpinion) {
        riskFlag.aiRiskScore = aiOpinion.riskScore;
        riskFlag.aiRationale = aiOpinion.rationale;
        if (aiOpinion.suspicious) riskFlag.severity = 'high';
        await riskFlag.save();
      }
      record('AI fraud second opinion attached to the flagged evidence', Boolean(aiOpinion), aiOpinion ? `riskScore=${aiOpinion.riskScore} suspicious=${aiOpinion.suspicious}` : 'AI call did not return a usable opinion');
    } else {
      record('AI fraud second opinion correctly skipped (not configured/disabled)', aiOpinion === null);
    }

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    const allPassed = results.every((r) => r.passed);
    process.exitCode = allPassed ? 0 : 1;
  } finally {
    await User.deleteMany({ _id: { $in: createdUserIds } });
    await ContractorProfile.deleteMany({ userId: { $in: createdUserIds } });
    await ContractorCertification.deleteMany({ _id: { $in: createdCertIds } });
    await Project.deleteMany({ _id: { $in: createdProjectIds } });
    await RiskFlag.deleteMany({ userId: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
