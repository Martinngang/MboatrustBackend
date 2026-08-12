const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const env = require('../config/env');

const CALL_TIMEOUT_MS = 15_000;

/** Mirrors kycService.js's isConfigured() pattern: "AI is on" just means a
 * key is present — every caller must treat an absent key as "fall back to
 * heuristic-only", never as an error. */
function isAiConfigured() {
  return Boolean(env.ai.geminiApiKey);
}

let client = null;
function getClient() {
  if (!client) client = new GoogleGenerativeAI(env.ai.geminiApiKey);
  return client;
}

async function fetchImageAsInlineData(imageUrl) {
  const res = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: CALL_TIMEOUT_MS });
  const mimeType = res.headers['content-type'] || 'image/jpeg';
  return { inlineData: { data: Buffer.from(res.data).toString('base64'), mimeType } };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('AI call timed out')), ms)),
  ]);
}

/** Is this failure worth one retry? Only transient conditions — a genuinely
 * bad request (bad key, invalid model, malformed input) will fail the same
 * way twice, so retrying it just doubles the latency for no benefit. */
function isRetryable(error) {
  if (error.message === 'AI call timed out') return true;
  const status = error?.status || error?.response?.status;
  return typeof status === 'number' && status >= 500;
}

/**
 * One call, always safe to await inline: never throws, always resolves.
 * Callers that get `{ ok: false }` back must fall back to heuristic-only
 * behavior rather than surface an error to the end user — an AI outage must
 * never block evidence submission, milestone review, or a matching request.
 */
// Gemini's "thinking" tokens count against maxOutputTokens before any visible
// text is produced (confirmed live: a trivial one-line JSON reply consumed
// ~160 thinking tokens on top of the ~15 visible ones) — the default has to
// budget for that or short, well-formed answers get silently truncated.
async function analyzeWithGemini({ system, prompt, imageUrl, maxTokens = 2000 }) {
  if (!isAiConfigured()) return { ok: false, error: 'AI not configured' };

  const attempt = async () => {
    const model = getClient().getGenerativeModel({
      model: env.ai.model,
      systemInstruction: system,
      generationConfig: { maxOutputTokens: maxTokens },
    });
    const parts = [{ text: prompt }];
    if (imageUrl) parts.push(await fetchImageAsInlineData(imageUrl));
    const result = await withTimeout(model.generateContent(parts), CALL_TIMEOUT_MS);
    return result.response.text();
  };

  try {
    const text = await attempt();
    return { ok: true, text };
  } catch (firstError) {
    if (!isRetryable(firstError)) return { ok: false, error: firstError.message };
    try {
      const text = await attempt();
      return { ok: true, text };
    } catch (secondError) {
      return { ok: false, error: secondError.message };
    }
  }
}

/** Models occasionally wrap JSON in prose or a ```json fence despite being
 * asked for strict JSON — strip that before parsing, and return null
 * (never throw) so callers can fall back cleanly. */
function parseJsonResponse(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    return null;
  }
}

module.exports = { isAiConfigured, analyzeWithGemini, parseJsonResponse };
