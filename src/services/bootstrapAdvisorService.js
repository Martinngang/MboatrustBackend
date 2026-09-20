const env = require('../config/env');
const { User } = require('../models');

/**
 * Ensures exactly one singleton "Mboa Trust Advisor" User document exists —
 * the real account the AI Advisor chat (see advisorReplyService.js) sends
 * and receives messages as. Modeled on bootstrapAdminService.js's idempotent
 * boot-time pattern, but unlike that one this always creates the account
 * itself: there is no real person behind it to promote. Matches on `email`
 * (unique+sparse on User), so re-running on every restart after the first is
 * a no-op — $setOnInsert only ever applies on the very first call.
 */
let cachedAdvisorId = null;

async function bootstrapAiAdvisor() {
  const email = env.ai.advisorEmail;
  const advisor = await User.findOneAndUpdate(
    { email },
    {
      $setOnInsert: {
        fullName: env.ai.advisorName,
        email,
        isSystemAccount: true,
        onboardingCompleted: true,
        isActive: true,
        preferredLanguage: 'en',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  cachedAdvisorId = String(advisor._id);
  console.log(`[bootstrapAiAdvisor] Advisor account ready: ${advisor.email} (${advisor._id})`);
  return advisor;
}

/** Synchronous accessor for the Advisor's user id — populated once at boot
 * (see server.js), before any request can reach a route that needs it.
 * Throws loudly if ever called before boot finishes rather than silently
 * returning undefined and producing a confusing downstream Mongoose error. */
function getAdvisorUserId() {
  if (!cachedAdvisorId) throw new Error('Advisor user id requested before bootstrapAiAdvisor() ran');
  return cachedAdvisorId;
}

module.exports = { bootstrapAiAdvisor, getAdvisorUserId };
