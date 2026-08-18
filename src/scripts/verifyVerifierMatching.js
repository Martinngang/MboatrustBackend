// Real, end-to-end proof that the verifier-matching suggestion list
// (GET /verification-tasks/recommended-verifiers) actually ranks approved
// verifiers sensibly: closer beats farther, specialty match beats no match,
// a lighter caseload beats a heavier one, and only approved applications
// are ever suggested — a pending/rejected applicant must never show up
// regardless of how well their profile would otherwise score. Genuine HTTP
// requests against a running server (npm run dev). Safe to re-run any
// time — every fixture is tagged and deleted again at the end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, VerifierProfile, VerificationTask, Project } = require('../models');

const TAG = 'verify-verifier-matching-script';
const BASE_URL = process.env.VERIFY_BASE_URL || 'http://localhost:5000/api/v1';
const SITE_LOCATION = { lat: 4.05, lng: 9.7 }; // Douala-ish

const results = [];
function record(label, passed, detail = '') {
  results.push({ label, passed });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

function asUser(userId) {
  return axios.create({
    baseURL: BASE_URL,
    headers: { 'x-dev-user-id': String(userId) },
    validateStatus: () => true,
  });
}

async function makeVerifier({ suffix, lat, lng, specialties, isAvailable, applicationStatus }) {
  const user = await User.create({
    fullName: `${TAG} ${suffix}`,
    email: `${TAG}-${suffix}-${Date.now()}@test.local`,
    firebaseUid: `${TAG}-${suffix}-${Date.now()}`,
    roles: applicationStatus === 'approved' ? [{ roleType: 'verifier' }] : [],
  });
  const profile = await VerifierProfile.create({
    userId: user._id,
    specialties,
    regions: ['Littoral'],
    location: { lat, lng },
    isAvailable,
    applicationStatus,
  });
  return { user, profile };
}

async function run() {
  await connectDB();
  const createdUserIds = [];
  const createdTaskIds = [];
  const createdProjectIds = [];

  try {
    const admin = await User.create({
      fullName: `${TAG} Admin`,
      email: `${TAG}-admin-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-admin-${Date.now()}`,
      roles: [{ roleType: 'admin' }],
    });
    createdUserIds.push(admin._id);
    const adminClient = asUser(admin._id);

    // A tender/funding project with a real category + site location, so the
    // matcher has both specialty and proximity signals to score against.
    const owner = await User.create({
      fullName: `${TAG} Owner`,
      email: `${TAG}-owner-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-owner-${Date.now()}`,
      roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(owner._id);
    const project = await Project.create({
      projectType: 'funding',
      ownerId: owner._id,
      title: `${TAG} project`,
      category: 'Water & Sanitation',
      location: SITE_LOCATION,
      totalAmount: 100000,
      milestones: [{ name: 'Foundation', amount: 100000, orderIndex: 0 }],
    });
    createdProjectIds.push(project._id);
    const milestoneId = project.milestones[0]._id;

    // ── Candidates ─────────────────────────────────────────────────────
    const near = await makeVerifier({
      suffix: 'near-match-light', lat: 4.06, lng: 9.71, // ~1.5km away
      specialties: ['Water & Sanitation'], isAvailable: true, applicationStatus: 'approved',
    });
    const far = await makeVerifier({
      suffix: 'far-match-light', lat: 5.96, lng: 10.15, // ~230km away (Bamenda-ish)
      specialties: ['Water & Sanitation'], isAvailable: true, applicationStatus: 'approved',
    });
    const nearNoMatch = await makeVerifier({
      suffix: 'near-nomatch-light', lat: 4.06, lng: 9.71,
      specialties: ['Electrical'], isAvailable: true, applicationStatus: 'approved',
    });
    const nearMatchLoaded = await makeVerifier({
      suffix: 'near-match-loaded', lat: 4.06, lng: 9.71,
      specialties: ['Water & Sanitation'], isAvailable: true, applicationStatus: 'approved',
    });
    const pending = await makeVerifier({
      suffix: 'pending', lat: 4.05, lng: 9.7, // right on top of the site — would win on proximity alone
      specialties: ['Water & Sanitation'], isAvailable: true, applicationStatus: 'pending',
    });
    for (const c of [near, far, nearNoMatch, nearMatchLoaded, pending]) createdUserIds.push(c.user._id);

    // Give nearMatchLoaded 5 open tasks so the load penalty actually bites.
    for (let i = 0; i < 5; i++) {
      const task = await VerificationTask.create({
        targetType: 'milestone',
        targetId: new mongoose.Types.ObjectId(), // unrelated dummy targets, only the count matters
        verifierId: nearMatchLoaded.user._id,
        status: 'assigned',
      });
      createdTaskIds.push(task._id);
    }

    const res = await adminClient.get('/verification-tasks/recommended-verifiers', {
      params: { targetType: 'milestone', targetId: String(milestoneId) },
    });
    record('Recommendation endpoint returns 200 for an admin', res.status === 200, `status=${res.status}`);

    const ids = (res.data?.data ?? []).map((r) => r.verifierId);
    record('Pending applicant is never recommended, even though closest', !ids.includes(String(pending.user._id)));

    const byId = new Map((res.data?.data ?? []).map((r) => [String(r.verifierId), r]));
    const nearScore = byId.get(String(near.user._id))?.score?.total;
    const farScore = byId.get(String(far.user._id))?.score?.total;
    const nearNoMatchScore = byId.get(String(nearNoMatch.user._id))?.score?.total;
    const nearMatchLoadedScore = byId.get(String(nearMatchLoaded.user._id))?.score?.total;

    record('A closer verifier outranks a farther one, all else equal', typeof nearScore === 'number' && typeof farScore === 'number' && nearScore > farScore, `near=${nearScore} far=${farScore}`);
    record('A specialty match outranks a non-match at the same distance', typeof nearScore === 'number' && typeof nearNoMatchScore === 'number' && nearScore > nearNoMatchScore, `match=${nearScore} noMatch=${nearNoMatchScore}`);
    record('A lighter caseload outranks a loaded one, same distance/specialty', typeof nearScore === 'number' && typeof nearMatchLoadedScore === 'number' && nearScore > nearMatchLoadedScore, `light=${nearScore} loaded=${nearMatchLoadedScore}`);

    const sorted = [...(res.data?.data ?? [])].every((r, i, arr) => i === 0 || arr[i - 1].score.total >= r.score.total);
    record('Results are sorted descending by score', sorted);

    // Non-admin cannot call this.
    const nonAdminRes = await asUser(owner._id).get('/verification-tasks/recommended-verifiers', {
      params: { targetType: 'milestone', targetId: String(milestoneId) },
    });
    record('Non-admin cannot call the recommendation endpoint', nonAdminRes.status === 403, `got ${nonAdminRes.status}`);

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    await VerificationTask.deleteMany({ _id: { $in: createdTaskIds } });
    await Project.deleteMany({ _id: { $in: createdProjectIds } });
    await VerifierProfile.deleteMany({ userId: { $in: createdUserIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
