// Real, end-to-end proof of the AI Advisor chat: a fresh user opening the
// Dedicated Advisor thread gets a real, persisted, pinned conversation seeded
// with a greeting; a human message gets a genuine reply delivered through the
// normal message path (persisted, socket-delivered with typing events, and
// notified like any human reply); the thread stays pinned above more-recently-
// updated conversations; the Advisor never shows up in people-search; and
// normal human-to-human chat is untouched. Genuine HTTP requests + socket.io
// against a running server (npm run dev), plus direct DB reads for
// persistence checks. Safe to re-run — every fixture is tagged and removed at
// the end, pass or fail (the singleton Advisor account itself is left in
// place, exactly as a real server boot leaves it).
//
// Real-vs-mock: when GEMINI_API_KEY is set, the reply MUST be a real Gemini
// answer — the "temporarily unavailable" fallback counts as a FAIL, because a
// silently-degraded Gemini would otherwise pass every shape check. Run against
// a server started with GEMINI_API_KEY blank (VERIFY_EXPECT_AI=off) to prove
// the fallback path instead:
//   PORT=5051 GEMINI_API_KEY= node src/server.js
//   VERIFY_BASE_URL=http://localhost:5051/api/v1 VERIFY_EXPECT_AI=off node src/scripts/verifyAiAdvisor.js
const path = require('path');
const axios = require('axios');
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const env = require('../config/env');
const { User, Conversation, ConversationParticipant, Message, Notification } = require('../models');
const { bootstrapAiAdvisor } = require('../services/bootstrapAdvisorService');
const { GREETING_TEXT } = require('../services/advisorReplyService');

const TAG = 'verify-ai-advisor-script';
const BASE_URL = process.env.VERIFY_BASE_URL || 'http://localhost:5000/api/v1';
const SOCKET_URL = BASE_URL.replace(/\/api\/v1\/?$/, '');
const EXPECT_AI = (process.env.VERIFY_EXPECT_AI || (env.ai.geminiApiKey ? 'on' : 'off')).toLowerCase() === 'on';
const FALLBACK_TEXT = "I'm temporarily unavailable — please try again shortly.";

const results = [];
function record(label, passed, detail = '') {
  results.push({ label, passed });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

function asUser(userId) {
  return axios.create({ baseURL: BASE_URL, headers: { 'x-dev-user-id': String(userId) }, validateStatus: () => true });
}

async function waitFor(fn, { timeoutMs = 45_000, everyMs = 750 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

function loadSocketClient() {
  const candidates = [
    'socket.io-client',
    path.join(__dirname, '../../../MboaTrustFrontend/node_modules/socket.io-client'),
  ];
  for (const c of candidates) {
    try { return require(c).io; } catch { /* try next */ }
  }
  return null;
}

async function run() {
  await connectDB();
  const createdUserIds = [];
  const createdConversationIds = [];

  try {
    // ── 1. Bootstrap: one singleton Advisor, idempotent ───────────────────
    const first = await bootstrapAiAdvisor();
    const second = await bootstrapAiAdvisor();
    const advisorCount = await User.countDocuments({ email: env.ai.advisorEmail });
    record('Advisor bootstrap is idempotent (same account both runs, exactly one exists)',
      String(first._id) === String(second._id) && advisorCount === 1, `count=${advisorCount}`);
    record('Advisor account is flagged isSystemAccount and is not a real signup (no firebaseUid, no roles)',
      first.isSystemAccount === true && !first.firebaseUid && first.roles.length === 0);
    const advisorId = String(first._id);

    // ── Fixtures: a fresh user (A) and an ordinary counterpart (B) ─────────
    const stamp = Date.now();
    const userA = await User.create({ fullName: `${TAG} User A`, email: `${TAG}-a-${stamp}@test.local`, firebaseUid: `${TAG}-a-${stamp}`, roles: [{ roleType: 'funder' }] });
    const userB = await User.create({ fullName: `${TAG} User B`, email: `${TAG}-b-${stamp}@test.local`, firebaseUid: `${TAG}-b-${stamp}`, roles: [{ roleType: 'funder' }] });
    createdUserIds.push(userA._id, userB._id);
    const a = asUser(userA._id);

    // A normal conversation A↔B first, so there is something to be ordered against.
    const seedRes = await a.post('/messages/direct', { recipientId: String(userB._id), body: 'Hello B, ordinary chat' });
    const abConversationId = seedRes.data?.data?.conversation?._id;
    if (abConversationId) createdConversationIds.push(abConversationId);
    record('Setup: normal A↔B conversation created', seedRes.status === 201 && Boolean(abConversationId), `status=${seedRes.status}`);

    // ── 2. First open of the Advisor thread ───────────────────────────────
    const open1 = await a.post('/conversations/advisor');
    const conv1 = open1.data?.data?.conversation;
    const advConversationId = conv1?._id;
    if (advConversationId) createdConversationIds.push(advConversationId);
    record('POST /conversations/advisor returns a real (non-draft) conversation', open1.status === 200 && Boolean(advConversationId), `status=${open1.status}`);
    record('Response exposes the Advisor id and flags it isSystemAccount on the participant',
      open1.data?.data?.advisorUserId === advisorId && conv1?.participantIds?.some((p) => String(p._id) === advisorId && p.isSystemAccount === true));

    const msgsAfterOpen = await Message.find({ conversationId: advConversationId }).lean();
    record('First open seeded exactly one persisted message: the Advisor greeting',
      msgsAfterOpen.length === 1 && String(msgsAfterOpen[0].senderId) === advisorId && msgsAfterOpen[0].body === GREETING_TEXT, `messages=${msgsAfterOpen.length}`);

    const partRow = await ConversationParticipant.findOne({ conversationId: advConversationId, userId: userA._id }).lean();
    record('Conversation is pinned for the user (ConversationParticipant.pinnedAt set)', Boolean(partRow?.pinnedAt));

    // ── 3. Idempotent re-open ─────────────────────────────────────────────
    const open2 = await a.post('/conversations/advisor');
    const convCount = await Conversation.countDocuments({ participantIds: { $all: [userA._id, first._id] } });
    const msgsAfterReopen = await Message.countDocuments({ conversationId: advConversationId });
    record('Re-opening returns the same conversation, no duplicate conversation, no second greeting',
      open2.data?.data?.conversation?._id === advConversationId && convCount === 1 && msgsAfterReopen === 1, `conversations=${convCount} messages=${msgsAfterReopen}`);

    // ── 4. Real-time + reply: send a human message, listen on the socket ───
    const io = loadSocketClient();
    const socketEvents = [];
    let socket = null;
    if (io) {
      socket = io(SOCKET_URL, { auth: { devUserId: String(userA._id) }, transports: ['websocket'], reconnection: false });
      await new Promise((resolve) => { socket.on('connect', resolve); socket.on('connect_error', resolve); setTimeout(resolve, 5000); });
      socket.emit('conversation:join', advConversationId);
      await new Promise((r) => setTimeout(r, 400));
      socket.on('typing:start', (p) => socketEvents.push({ name: 'typing:start', p }));
      socket.on('typing:stop', (p) => socketEvents.push({ name: 'typing:stop', p }));
      socket.on('message:new', (m) => socketEvents.push({ name: 'message:new', m }));
    }

    const t0 = Date.now();
    const sendRes = await a.post(`/conversations/${advConversationId}/messages`, { body: 'In two sentences: how does escrow protect me when I fund a project?' });
    const sendMs = Date.now() - t0;
    record('Human message send returns 201 immediately (AI reply is not blocking the request)', sendRes.status === 201 && sendMs < 3000, `status=${sendRes.status} in ${sendMs}ms`);

    const reply = await waitFor(async () => {
      const m = await Message.findOne({ conversationId: advConversationId, senderId: first._id, body: { $ne: GREETING_TEXT } }).sort('-sentAt').lean();
      return m;
    });
    record('The Advisor replied through the normal message path (persisted as a Message from the Advisor)', Boolean(reply), reply ? '' : 'no reply within 45s');

    if (reply) {
      if (EXPECT_AI) {
        record('Reply is a REAL Gemini answer (not the "temporarily unavailable" fallback)',
          reply.body.trim().length > 0 && reply.body !== FALLBACK_TEXT, `"${reply.body.slice(0, 90).replace(/\n/g, ' ')}…"`);
      } else {
        record('With Gemini unavailable the Advisor still replies, with the fixed fallback (human message not dropped)', reply.body === FALLBACK_TEXT, `"${reply.body.slice(0, 60)}"`);
      }
    }

    if (socket) {
      await waitFor(async () => socketEvents.some((e) => e.name === 'typing:stop'), { timeoutMs: 8000, everyMs: 300 });
      const names = socketEvents.map((e) => e.name);
      const typingStart = socketEvents.find((e) => e.name === 'typing:start');
      record('Socket delivered "Advisor is typing" (typing:start) with the Advisor identity',
        Boolean(typingStart) && String(typingStart.p.userId) === advisorId, `events=${names.join(',')}`);
      record('Socket delivered the Advisor reply live (message:new) and then typing:stop',
        socketEvents.some((e) => e.name === 'message:new' && String(e.m?.senderId?._id ?? e.m?.senderId) === advisorId) && names.includes('typing:stop'));
      socket.close();
    } else {
      console.log('[SKIP] Socket checks — no socket.io-client available');
    }

    const notif = await waitFor(async () => Notification.findOne({ userId: userA._id, type: 'new_message', 'payload.senderName': first.fullName }).lean(), { timeoutMs: 5000, everyMs: 300 });
    record('The user got a real new_message notification for the Advisor reply, like any human reply', Boolean(notif));

    // ── 5. Ordering: pinned above a more-recently-updated conversation ────
    const bump = await a.post('/messages/direct', { recipientId: String(userB._id), body: 'Another ordinary message, newer than the Advisor thread' });
    const abConv = await Conversation.findById(abConversationId).lean();
    const advConv = await Conversation.findById(advConversationId).lean();
    record('Setup: A↔B is now the more recently updated conversation', bump.status === 201 && abConv.updatedAt > advConv.updatedAt);

    const listRes = await a.get('/conversations');
    const list = listRes.data?.data ?? [];
    record('GET /conversations lists the Advisor conversation FIRST and flags it pinned, above the newer ordinary one',
      listRes.status === 200 && list[0]?._id === advConversationId && list[0]?.pinned === true && list[1]?._id === abConversationId && list[1]?.pinned === false,
      `order=${list.map((c) => (c._id === advConversationId ? 'advisor' : c._id === abConversationId ? 'A-B' : '?')).join(',')}`);

    // ── 5b. Regression (found by the browser test): a conversation the user has
    // only ever RECEIVED has no ConversationParticipant row for them, so
    // pinnedAt is *missing*, not null. That must not count as pinned. ────────
    const userC = await User.create({ fullName: `${TAG} User C (sender only)`, email: `${TAG}-c-${stamp}@test.local`, firebaseUid: `${TAG}-c-${stamp}`, roles: [{ roleType: 'funder' }] });
    createdUserIds.push(userC._id);
    const recvRes = await asUser(userC._id).post('/messages/direct', { recipientId: String(userA._id), body: 'C → A: A has never opened or replied to this chat' });
    const caConversationId = recvRes.data?.data?.conversation?._id;
    if (caConversationId) createdConversationIds.push(caConversationId);
    const caRowForA = await ConversationParticipant.findOne({ conversationId: caConversationId, userId: userA._id }).lean();
    record('Setup: A has NO participant row for the received-only C→A chat (the "missing pinnedAt" case)', recvRes.status === 201 && !caRowForA);

    const list2Res = await a.get('/conversations');
    const list2 = list2Res.data?.data ?? [];
    const caItem = list2.find((c) => c._id === caConversationId);
    record('A received-only, newer conversation is NOT treated as pinned and does not outrank the Advisor',
      list2[0]?._id === advConversationId && list2[0]?.pinned === true && caItem?.pinned === false,
      `order=${list2.map((c) => (c._id === advConversationId ? 'advisor' : c._id === abConversationId ? 'A-B' : c._id === caConversationId ? 'C-A' : '?') + (c.pinned ? '*' : '')).join(',')}`);

    // ── 6. Not in people-search ───────────────────────────────────────────
    const searchRes = await a.get(`/users/search?q=${encodeURIComponent(first.fullName.slice(0, 7))}`);
    record('The Advisor never appears in the generic people-search', searchRes.status === 200 && !(searchRes.data?.data ?? []).some((u) => String(u._id) === advisorId), `results=${searchRes.data?.data?.length}`);

    // ── 7. Regression: ordinary chat is untouched ─────────────────────────
    const abMessages = await Message.find({ conversationId: abConversationId }).lean();
    record('Ordinary A↔B chat: no Advisor message was ever injected',
      abMessages.length === 2 && abMessages.every((m) => [String(userA._id), String(userB._id)].includes(String(m.senderId))), `messages=${abMessages.length}`);

    const target = abMessages[0];
    const editRes = await a.patch(`/messages/${target._id}`, { body: 'edited ordinary message' });
    const reactRes = await a.post(`/messages/${target._id}/react`, { emoji: '👍' });
    const delRes = await a.delete(`/messages/${target._id}`);
    record('Ordinary chat still supports edit / react / delete', editRes.status === 200 && reactRes.status === 200 && delRes.status === 200, `edit=${editRes.status} react=${reactRes.status} delete=${delRes.status}`);

    const readRes = await a.post(`/conversations/${advConversationId}/read`);
    record('Mark-read still works on the Advisor thread', readRes.status === 200);

    // ── 7b. Account deletion erases the private Advisor thread whole ──────
    // (No firebaseUid on this user, so hardDeleteUser never calls Firebase.)
    const userD = await User.create({ fullName: `${TAG} User D (to be deleted)`, email: `${TAG}-d-${stamp}@test.local`, roles: [{ roleType: 'funder' }] });
    createdUserIds.push(userD._id);
    const d = asUser(userD._id);
    const dOpen = await d.post('/conversations/advisor');
    const dConvId = dOpen.data?.data?.conversation?._id;
    if (dConvId) createdConversationIds.push(dConvId);
    await d.post(`/conversations/${dConvId}/messages`, { body: 'Please remember my account number 12345' });
    await waitFor(async () => (await Message.countDocuments({ conversationId: dConvId })) >= 3, { timeoutMs: 45_000 });
    const beforeMsgs = await Message.countDocuments({ conversationId: dConvId });
    const { hardDeleteUser } = require('../services/userDeletionService');
    const delResult = await hardDeleteUser(userD._id);
    const afterConv = await Conversation.countDocuments({ _id: dConvId });
    const afterMsgs = await Message.countDocuments({ conversationId: dConvId });
    const afterRows = await ConversationParticipant.countDocuments({ conversationId: dConvId });
    const advisorStillThere = await User.countDocuments({ _id: first._id });
    const aStillThere = await Conversation.countDocuments({ _id: advConversationId });
    record('Hard-deleting an account erases their whole Advisor thread (conversation, BOTH sides\' messages, pin/read rows) — no orphan',
      delResult.deleted && beforeMsgs >= 3 && afterConv === 0 && afterMsgs === 0 && afterRows === 0, `before: ${beforeMsgs} messages; after: conv=${afterConv} msgs=${afterMsgs} rows=${afterRows}`);
    record('...while the Advisor account and other users\' Advisor threads are untouched', advisorStillThere === 1 && aStillThere === 1);

    // ── 8. The per-user AI-chat rate limiter is wired onto message send ───
    const rlHeader = sendRes.headers['ratelimit-limit'] || (sendRes.headers['ratelimit'] || '').match(/limit=(\d+)/)?.[1];
    record('Per-user message limiter (60 / 10 min) is active on the send route', String(rlHeader) === '60', `ratelimit-limit=${rlHeader}`);

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend running?`);
    throw err;
  } finally {
    if (createdConversationIds.length || createdUserIds.length) {
      const advisor = await User.findOne({ email: env.ai.advisorEmail }).select('_id').lean();
      const advConvs = advisor ? await Conversation.find({ participantIds: { $in: createdUserIds, $all: [advisor._id] } }).select('_id').lean() : [];
      const allConvIds = [...new Set([...createdConversationIds.map(String), ...advConvs.map((c) => String(c._id))])];
      await Message.deleteMany({ conversationId: { $in: allConvIds } });
      await ConversationParticipant.deleteMany({ conversationId: { $in: allConvIds } });
      await Conversation.deleteMany({ _id: { $in: allConvIds } });
      await Notification.deleteMany({ userId: { $in: createdUserIds } });
      await User.deleteMany({ _id: { $in: createdUserIds } });
    }
    console.log('\n[cleanup] verification fixtures removed (the singleton Advisor account is intentionally kept).');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
