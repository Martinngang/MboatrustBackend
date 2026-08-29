// Real, end-to-end proof for contractor portfolios + the public leaderboard:
// genuine HTTP requests (including a real multipart image upload) against a
// running server. Safe to re-run any time: every fixture is tagged and
// deleted again at the end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, ContractorProfile, Project, Bid, Contract, Rating } = require('../models');

const TAG = 'verify-contractor-portfolio-script';
const BASE_URL = process.env.VERIFY_BASE_URL || 'http://localhost:5000/api/v1';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const results = [];
function record(label, passed, detail = '') {
  results.push({ label, passed });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

function asUser(userId) {
  return axios.create({ baseURL: BASE_URL, headers: { 'x-dev-user-id': String(userId) }, validateStatus: () => true });
}

async function run() {
  await connectDB();
  const createdUserIds = [];
  const createdProjectIds = [];

  try {
    const contractor = await User.create({
      fullName: `${TAG} Contractor`,
      email: `${TAG}-contractor-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-contractor-${Date.now()}`,
      roles: [{ roleType: 'contractor' }],
      kycStatus: 'verified',
    });
    const funder = await User.create({
      fullName: `${TAG} Funder`,
      email: `${TAG}-funder-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-funder-${Date.now()}`,
      roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(contractor._id, funder._id);
    const contractorClient = asUser(contractor._id);
    const funderClient = asUser(funder._id);

    // ── Profile upsert with a real multipart image upload ──────────────
    const form = new FormData();
    form.append('headline', 'Master Mason — 12 years, Douala');
    form.append('services', JSON.stringify(['Foundation work', 'Tiling']));
    form.append('yearsExperience', '12');
    form.append('categories', JSON.stringify(['Masonry']));
    form.append('bio', 'Built this business from the ground up.');
    const blob = new Blob([Buffer.from(PNG_B64, 'base64')], { type: 'image/png' });
    form.append('images', blob, 'portfolio1.png');

    const upsert = await contractorClient.put('/contractor-profiles/me', form);
    record('Contractor can upsert profile with a real image upload', upsert.status === 200 && upsert.data?.data?.portfolioImages?.length === 1, `status=${upsert.status}`);
    record('Headline/services/bio persisted', upsert.data?.data?.headline === 'Master Mason — 12 years, Douala' && upsert.data?.data?.services?.length === 2);

    const uploadedUrl = upsert.data?.data?.portfolioImages?.[0]?.url;
    if (uploadedUrl) {
      const imgCheck = await axios.get(uploadedUrl, { validateStatus: () => true });
      record('Uploaded portfolio image is publicly fetchable from Cloudinary', imgCheck.status === 200);
    } else {
      record('Uploaded portfolio image is publicly fetchable from Cloudinary', false, 'no url returned');
    }

    // Non-contractor cannot upsert.
    const nonContractorAttempt = await funderClient.put('/contractor-profiles/me', { headline: 'x' });
    record('A non-contractor account cannot upsert a contractor profile', nonContractorAttempt.status === 403, `got ${nonContractorAttempt.status}`);

    // ── Public profile view shows the new fields ────────────────────────
    const publicView = await funderClient.get(`/contractor-profiles/${contractor._id}`);
    record('Public profile view (what a funder sees) includes headline/services/portfolioImages', publicView.data?.data?.headline && publicView.data?.data?.services?.length === 2 && publicView.data?.data?.portfolioImages?.length === 1);

    // ── Real completed work ──────────────────────────────────────────────
    const project = await Project.create({
      title: `${TAG} Real Project`, category: 'Housing', locationName: 'Douala',
      ownerId: funder._id, projectType: 'tender', totalAmount: 500000, status: 'completed',
    });
    createdProjectIds.push(project._id);
    const bid = await Bid.create({ projectId: project._id, contractorId: contractor._id, price: 480000, timelineDays: 30, status: 'accepted' });
    const contract = await Contract.create({ projectId: project._id, bidId: bid._id, status: 'completed' });

    const completedWork = await funderClient.get(`/contractor-profiles/${contractor._id}/completed-work`);
    record(
      'Completed work is derived live from real Bid/Contract/Project records',
      completedWork.status === 200 && completedWork.data?.data?.some((w) => w.projectTitle === `${TAG} Real Project` && w.category === 'Housing')
    );

    // A rating so the leaderboard/stats have a real signal.
    await Rating.create({ fromUserId: funder._id, toUserId: contractor._id, projectId: project._id, score: 5, roleContext: 'contractor', comment: 'Excellent work' });

    // ── Public leaderboard, no auth at all ───────────────────────────────
    const leaderboardNoAuth = await axios.get(`${BASE_URL}/contractor-profiles/leaderboard`, { validateStatus: () => true });
    record('Leaderboard is reachable with zero auth (truly public)', leaderboardNoAuth.status === 200);
    const row = leaderboardNoAuth.data?.data?.find((r) => String(r.userId) === String(contractor._id));
    record('This contractor appears on the leaderboard with a rank and a score breakdown', Boolean(row?.rank) && typeof row?.score?.total === 'number' && Boolean(row?.score?.breakdown));
    record('Leaderboard reflects the real rating/completed-project just created', row && row.stats.ratingCount >= 1 && row.stats.completedProjects >= 1, JSON.stringify(row?.stats));

    // Filter by category should still find them.
    const filtered = await axios.get(`${BASE_URL}/contractor-profiles/leaderboard`, { params: { category: 'Masonry' }, validateStatus: () => true });
    record('Leaderboard category filter works', filtered.data?.data?.some((r) => String(r.userId) === String(contractor._id)));

    // Search by name.
    const searched = await axios.get(`${BASE_URL}/contractor-profiles/leaderboard`, { params: { search: `${TAG} Contractor` }, validateStatus: () => true });
    record('Leaderboard search-by-name works', searched.data?.data?.length === 1 && String(searched.data.data[0].userId) === String(contractor._id));

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    await Contract.deleteMany({ projectId: { $in: createdProjectIds } });
    await Bid.deleteMany({ projectId: { $in: createdProjectIds } });
    await Rating.deleteMany({ projectId: { $in: createdProjectIds } });
    await Project.deleteMany({ _id: { $in: createdProjectIds } });
    await ContractorProfile.deleteMany({ userId: { $in: createdUserIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
