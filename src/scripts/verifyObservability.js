// Real, end-to-end proof that the observability layer actually works: a
// real (bad-key) Gemini failure gets recorded as a SystemEvent, a malformed
// webhook payload gets the correct error response AND a persisted event,
// /health reports real DB state and config presence, an unauthenticated
// crash report persists with userId:null, and the admin system-health
// endpoint aggregates + is actually admin-gated. Genuine HTTP requests
// against a running server (npm run dev) plus two direct service calls
// (forcing a real AI failure needs a bad key set at call time, not
// something reachable through any HTTP route). Safe to re-run any time —
// every fixture is tagged and deleted again at the end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, Project, SystemEvent } = require('../models');
const env = require('../config/env');

const TAG = 'verify-observability-script';
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
const anon = axios.create({ baseURL: BASE_URL, validateStatus: () => true });
const ROOT_URL = BASE_URL.replace(/\/api\/v1\/?$/, '');
const rootClient = axios.create({ baseURL: ROOT_URL, validateStatus: () => true });

async function run() {
  await connectDB();
  const createdUserIds = [];
  const createdProjectIds = [];
  const createdEventIds = [];

  try {
    // ── 1. /health reports real DB state + config presence ─────────────
    const health = await rootClient.get('/health'); // /health is outside /api/v1
    record('GET /health returns 200 with a connected DB', health.status === 200 && health.data?.db?.connected === true, `status=${health.status}`);
    record('GET /health reports config presence booleans', typeof health.data?.config?.gemini === 'boolean' && typeof health.data?.config?.stripe === 'boolean', JSON.stringify(health.data?.config));

    // ── 2. A real (bad-key) Gemini failure gets recorded ────────────────
    // Uses evidenceAnalysisService.getAiSecondOpinion directly — this is an
    // internal service function's failure path, not something reachable
    // through an HTTP route, so it's called in-process with a deliberately
    // invalid key restored immediately after.
    const evidenceAnalysisService = require('../services/evidenceAnalysisService');
    const realGeminiKey = env.ai.geminiApiKey;
    const realFraudEnabled = env.ai.fraudAnalysisEnabled;
    env.ai.geminiApiKey = 'invalid-test-key-forces-a-real-401';
    env.ai.fraudAnalysisEnabled = true;
    try {
      const fakeProject = { _id: new mongoose.Types.ObjectId(), category: 'Water & Sanitation', description: 'test' };
      const fakeMilestone = { _id: new mongoose.Types.ObjectId(), name: 'Test milestone', description: '' };
      const opinion = await evidenceAnalysisService.getAiSecondOpinion({
        analysis: { duplicateFlag: true, locationMatch: null, timestampRecent: null },
        project: fakeProject,
        milestone: fakeMilestone,
        fileUrl: 'https://example.com/test.jpg',
        evidenceType: 'photo',
      });
      record('AI second opinion returns null on a real call failure (never throws)', opinion === null);

      // logEvent is fire-and-forget (.catch(() => {})) inside the service —
      // give it a moment to actually land before querying for it.
      await new Promise((r) => setTimeout(r, 500));
      const aiFailureEvent = await SystemEvent.findOne({ type: 'ai_call_failed', 'detail.milestoneId': fakeMilestone._id }).lean();
      record('A real AI call failure is recorded as a SystemEvent', Boolean(aiFailureEvent));
      if (aiFailureEvent) createdEventIds.push(aiFailureEvent._id);
    } finally {
      env.ai.geminiApiKey = realGeminiKey;
      env.ai.fraudAnalysisEnabled = realFraudEnabled;
    }

    // ── 3. A malformed webhook payload gets the right error AND is recorded ──
    const malformedWebhook = await anon.post('/payments/flutterwave/webhook', { not: 'a real payload' });
    record('Malformed Flutterwave webhook payload gets a 400', malformedWebhook.status === 400, `status=${malformedWebhook.status}`);
    await new Promise((r) => setTimeout(r, 300));
    const webhookEvent = await SystemEvent.findOne({ type: 'webhook_error', source: 'paymentWebhookController.flutterwaveWebhook' }).sort('-createdAt').lean();
    record('Malformed webhook is recorded as a SystemEvent', Boolean(webhookEvent));
    if (webhookEvent) createdEventIds.push(webhookEvent._id);

    // ── 4. An unauthenticated crash report persists with userId:null ────
    const crashReport = await anon.post('/system-events', {
      type: 'frontend_crash',
      source: `${TAG}-ScreenErrorBoundary`,
      detail: { message: 'Simulated crash for verification' },
    });
    record('Unauthenticated crash report is accepted (201)', crashReport.status === 201, `status=${crashReport.status}`);
    const crashEventId = crashReport.data?.data?._id;
    if (crashEventId) createdEventIds.push(crashEventId);
    const crashEvent = crashEventId ? await SystemEvent.findById(crashEventId).lean() : null;
    record('Crash report persists with userId:null', Boolean(crashEvent) && crashEvent.userId === null);

    // ── 5. Admin system-health endpoint is real and admin-gated ─────────
    const admin = await User.create({
      fullName: `${TAG} Admin`, email: `${TAG}-admin-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-admin-${Date.now()}`, roles: [{ roleType: 'admin' }],
    });
    const outsider = await User.create({
      fullName: `${TAG} Outsider`, email: `${TAG}-outsider-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-outsider-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(admin._id, outsider._id);

    const nonAdminHealth = await asUser(outsider._id).get('/admin/system-health');
    record('Non-admin cannot view system health', nonAdminHealth.status === 403, `got ${nonAdminHealth.status}`);

    const adminHealth = await asUser(admin._id).get('/admin/system-health');
    record(
      'Admin system-health aggregates real counts and recent events',
      adminHealth.status === 200 && typeof adminHealth.data?.data?.countByType === 'object' && Array.isArray(adminHealth.data?.data?.recentEvents),
      `status=${adminHealth.status}`
    );
    record(
      'Admin system-health includes the crash report just created',
      (adminHealth.data?.data?.recentEvents ?? []).some((e) => e._id === crashEventId)
    );

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    await SystemEvent.deleteMany({ _id: { $in: createdEventIds.filter(Boolean) } });
    await Project.deleteMany({ _id: { $in: createdProjectIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
