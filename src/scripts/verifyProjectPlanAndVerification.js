// Real, end-to-end proof that the project-plan-upload and
// location-verification-request features actually work: uploading a plan
// document flips a public boolean flag without ever exposing the real
// fileUrl to an unauthorized viewer; requesting a verifier for a project
// with no known location assigns a real approved verifier via the shared
// matching engine; and the verifier's submitted report writes the
// confirmed coordinates straight back onto the project. Genuine HTTP
// requests against a running server (npm run dev). Safe to re-run any
// time — every fixture created here is deleted at the end, pass or fail.
const axios = require('axios');
const FormData = require('form-data');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, Project, VerifierProfile, VerificationTask } = require('../models');

const TAG = 'verify-plan-verification-script';
const BASE_URL = process.env.VERIFY_BASE_URL || 'http://localhost:5000/api/v1';

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

async function run() {
  await connectDB();
  const createdUserIds = [];
  const createdProjectIds = [];
  const createdVerifierProfileIds = [];
  const createdTaskIds = [];

  try {
    const owner = await User.create({
      fullName: `${TAG} Owner`, email: `${TAG}-owner-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-owner-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    const stranger = await User.create({
      fullName: `${TAG} Stranger`, email: `${TAG}-stranger-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-stranger-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    const contractor = await User.create({
      fullName: `${TAG} Contractor`, email: `${TAG}-contractor-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-contractor-${Date.now()}`, roles: [{ roleType: 'contractor' }],
    });
    const verifierUser = await User.create({
      fullName: `${TAG} Verifier`, email: `${TAG}-verifier-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-verifier-${Date.now()}`, roles: [{ roleType: 'verifier' }],
    });
    createdUserIds.push(owner._id, stranger._id, contractor._id, verifierUser._id);

    const verifierProfile = await VerifierProfile.create({
      userId: verifierUser._id,
      specialties: ['General'],
      regions: ['Centre'],
      applicationStatus: 'approved',
      isAvailable: true,
    });
    createdVerifierProfileIds.push(verifierProfile._id);

    const ownerClient = asUser(owner._id);
    const strangerClient = asUser(stranger._id);
    const contractorClient = asUser(contractor._id);
    const verifierClient = asUser(verifierUser._id);

    // ── Create a project with NO location and hasExistingPlan:false ───────
    const projectRes = await ownerClient.post('/projects', {
      projectType: 'tender',
      title: `${TAG} Project`,
      description: 'x',
      category: 'General',
      locationName: '',
      hasExistingPlan: false,
      totalAmount: 100000,
      milestones: [{ name: 'Milestone 1', description: 'x', amount: 100000, orderIndex: 0 }],
    });
    const projectId = projectRes.data?.data?._id;
    createdProjectIds.push(projectId);
    record('Project created with no location — status=201', projectRes.status === 201, `status=${projectRes.status}`);
    record('Project.location is unset, not auto-geocoded from nothing', projectRes.data?.data?.location?.lat == null);
    record('locationVerificationStatus defaults to not_requested', projectRes.data?.data?.locationVerificationStatus === 'not_requested');
    record('hasPlanDocument defaults to false', projectRes.data?.data?.hasPlanDocument === false);

    // ── Plan document upload + public/private field split ──────────────────
    const form = new FormData();
    form.append('file', Buffer.from('%PDF-1.4 fake test plan content'), { filename: 'plan.pdf', contentType: 'application/pdf' });
    const uploadRes = await ownerClient.post(`/projects/${projectId}/plan-document`, form, { headers: form.getHeaders() });
    record('Owner can upload a plan document — status=201', uploadRes.status === 201, `status=${uploadRes.status}`);

    const publicView = await ownerClient.get(`/projects/${projectId}`);
    record('Public GET /projects/:id now shows hasPlanDocument:true', publicView.data?.data?.hasPlanDocument === true);
    record('Public GET /projects/:id never exposes the real planDocument object', publicView.data?.data?.planDocument === undefined);

    const strangerPlanReq = await strangerClient.get(`/projects/${projectId}/plan-document`);
    record('An unrelated funder cannot fetch the real plan document — got 403', strangerPlanReq.status === 403, `status=${strangerPlanReq.status}`);

    const contractorPlanReq = await contractorClient.get(`/projects/${projectId}/plan-document`);
    record('A contractor (reviewing the tender) CAN fetch the real plan document — status=200', contractorPlanReq.status === 200, `status=${contractorPlanReq.status}`);
    record('The real fileUrl is actually returned to an authorized viewer', typeof contractorPlanReq.data?.data?.fileUrl === 'string' && contractorPlanReq.data.data.fileUrl.length > 0);

    const ownerPlanReq = await ownerClient.get(`/projects/${projectId}/plan-document`);
    record('The owner can always fetch their own plan document — status=200', ownerPlanReq.status === 200, `status=${ownerPlanReq.status}`);

    // ── Recommended verifiers + request-location-verification ─────────────
    const recRes = await ownerClient.get(`/projects/${projectId}/recommended-verifiers`);
    record('Owner can list recommended verifiers for their own project — status=200', recRes.status === 200, `status=${recRes.status}`);
    record('The real approved verifier fixture appears in the recommendations', recRes.data?.data?.some((v) => String(v.verifierId) === String(verifierUser._id)));

    const strangerRecRes = await strangerClient.get(`/projects/${projectId}/recommended-verifiers`);
    record('An unrelated funder cannot list recommended verifiers for someone else\'s project — got 403', strangerRecRes.status === 403, `status=${strangerRecRes.status}`);

    const requestRes = await ownerClient.post(`/projects/${projectId}/request-location-verification`, { verifierId: verifierUser._id });
    record('Owner can request location verification — status=201', requestRes.status === 201, `status=${requestRes.status}`);
    const taskId = requestRes.data?.data?.task?._id;
    if (taskId) createdTaskIds.push(taskId);

    const afterRequest = await ownerClient.get(`/projects/${projectId}`);
    record('Project.locationVerificationStatus flips to requested', afterRequest.data?.data?.locationVerificationStatus === 'requested');

    const strangerRequestRes = await strangerClient.post(`/projects/${projectId}/request-location-verification`, { verifierId: verifierUser._id });
    record('An unrelated funder cannot request verification on someone else\'s project — got 403', strangerRequestRes.status === 403, `status=${strangerRequestRes.status}`);

    // ── Verifier submits a report with confirmed coordinates ──────────────
    const startRes = await verifierClient.post(`/verification-tasks/${taskId}/start`);
    record('Assigned verifier can start the task — status=200', startRes.status === 200, `status=${startRes.status}`);

    const reportRes = await verifierClient.post(`/verification-tasks/${taskId}/report`, {
      reportText: 'Confirmed the site in person.',
      confirmedMatch: true,
      confirmedLocation: { lat: 4.05, lng: 9.7 },
    });
    record('Verifier can submit a report with confirmedLocation — status=200', reportRes.status === 200, `status=${reportRes.status}`);

    const afterConfirm = await ownerClient.get(`/projects/${projectId}`);
    record('Project.location is now the verifier-confirmed coordinates', afterConfirm.data?.data?.location?.lat === 4.05 && afterConfirm.data?.data?.location?.lng === 9.7);
    record('Project.locationVerificationStatus flips to confirmed', afterConfirm.data?.data?.locationVerificationStatus === 'confirmed');

    const strangerReportRes = await strangerClient.post(`/verification-tasks/${taskId}/report`, { reportText: 'x', confirmedMatch: true });
    record('An unrelated user cannot submit a report on someone else\'s task — got 403', strangerReportRes.status === 403, `status=${strangerReportRes.status}`);

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
    await VerifierProfile.deleteMany({ _id: { $in: createdVerifierProfileIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
