const env = require('../config/env');
const { Message, User } = require('../models');
const { analyzeWithGemini, isAiConfigured } = require('./aiClient');
const { getAdvisorUserId } = require('./bootstrapAdvisorService');
const { logEvent } = require('./systemEventService');

const HISTORY_LIMIT = 20;
const REPLY_MAX_TOKENS = 500;
const FALLBACK_TEXT = "I'm temporarily unavailable — please try again shortly.";
const NON_TEXT_TEXT =
  "Thanks for sharing that! I can only read text messages right now — could you describe what you'd like help with?";
const GREETING_TEXT =
  "Hi! I'm the Mboa Trust Advisor. Ask me anything about funding a project, tendering for contractors, " +
  'verifying land, or how escrow and milestones work on the platform — I\'m here to help.';

const SYSTEM_PROMPT =
  'You are the Mboa Trust Advisor, an in-app chat assistant for Mboa Trust, a platform that lets the ' +
  'Cameroonian diaspora fund verified construction/infrastructure projects back home, tender the work to ' +
  'vetted contractors, and buy/sell verified land — with escrow-held milestone payments and third-party ' +
  'field verification protecting every party. Answer questions about how the platform works (funding, ' +
  'bidding/tendering, escrow, milestones, KYC, land listings, payouts) clearly and concisely, like a real ' +
  'support chat message — a few sentences, no markdown headers, no bullet-point essays unless asked for a ' +
  'list. You are not a lawyer or financial adviser: for anything with real legal/financial consequences, ' +
  'point the person to the appropriate in-app flow or a qualified professional instead of giving a ' +
  'definitive answer. If you do not know something platform-specific, say so plainly instead of guessing.';

let cachedAdvisorUser = null;
async function getCachedAdvisorUser() {
  if (!cachedAdvisorUser) cachedAdvisorUser = await User.findById(getAdvisorUserId());
  return cachedAdvisorUser;
}

function isDirectWithAdvisor(conversation) {
  if (conversation.contextType !== 'direct') return false;
  if (!conversation.participantIds || conversation.participantIds.length !== 2) return false;
  const advisorId = getAdvisorUserId();
  return conversation.participantIds.some((p) => String(p._id || p) === advisorId);
}

async function emitTyping(io, conversationId, isTyping) {
  if (!io) return;
  const advisor = await getCachedAdvisorUser();
  io.to(`conversation:${conversationId}`).emit(isTyping ? 'typing:start' : 'typing:stop', {
    userId: getAdvisorUserId(),
    fullName: advisor.fullName,
  });
}

async function sendGreeting(conversation, io) {
  const { deliverMessage } = require('../controllers/messageController'); // lazy — avoids a require cycle
  const advisor = await getCachedAdvisorUser();
  await deliverMessage(conversation, advisor, { body: GREETING_TEXT }, io);
}

async function buildHistory(conversationId, advisorId) {
  const recent = await Message.find({ conversationId, deletedAt: null })
    .sort('-sentAt')
    .limit(HISTORY_LIMIT)
    .select('senderId body sentAt');
  return recent
    .reverse()
    .map((m) => ({ role: String(m.senderId) === advisorId ? 'model' : 'user', text: m.body || '' }))
    .filter((t) => t.text);
}

/** Called after a human's message is already saved (see messageController's
 * create()/createDirect() — never from inside deliverMessage() itself, so
 * the Advisor's own reply, also delivered via deliverMessage, can never
 * recursively re-trigger another reply). Fire-and-forget from the caller's
 * perspective: never throws, always resolves. */
async function maybeReply(conversation, humanMessageBody, io) {
  if (!isDirectWithAdvisor(conversation)) return;

  const { deliverMessage } = require('../controllers/messageController'); // lazy — avoids a require cycle
  const advisor = await getCachedAdvisorUser();
  const advisorId = getAdvisorUserId();

  try {
    await emitTyping(io, conversation._id, true);
    const trimmed = (humanMessageBody || '').trim();

    if (!trimmed) {
      await deliverMessage(conversation, advisor, { body: NON_TEXT_TEXT }, io);
      return;
    }
    if (!env.ai.advisorChatEnabled || !isAiConfigured()) {
      await deliverMessage(conversation, advisor, { body: FALLBACK_TEXT }, io);
      return;
    }

    const fullHistory = await buildHistory(conversation._id, advisorId);
    const history = fullHistory.slice(0, -1); // the last row is the message we're replying to

    const result = await analyzeWithGemini({ system: SYSTEM_PROMPT, prompt: trimmed, history, maxTokens: REPLY_MAX_TOKENS });

    if (!result.ok || !result.text?.trim()) {
      if (!result.ok) {
        logEvent({
          type: 'ai_call_failed',
          source: 'advisorReplyService.maybeReply',
          detail: { conversationId: conversation._id, error: result.error },
        }).catch(() => {});
      }
      await deliverMessage(conversation, advisor, { body: FALLBACK_TEXT }, io);
      return;
    }

    await deliverMessage(conversation, advisor, { body: result.text.trim() }, io);
  } catch (err) {
    logEvent({
      type: 'ai_call_failed',
      severity: 'error',
      source: 'advisorReplyService.maybeReply',
      detail: { conversationId: conversation._id, error: err.message },
    }).catch(() => {});
    try {
      const { deliverMessage } = require('../controllers/messageController');
      await deliverMessage(conversation, advisor, { body: FALLBACK_TEXT }, io);
    } catch {
      // Last-resort — never throw out of a fire-and-forget hook.
    }
  } finally {
    await emitTyping(io, conversation._id, false);
  }
}

module.exports = { sendGreeting, maybeReply, isDirectWithAdvisor, GREETING_TEXT };
