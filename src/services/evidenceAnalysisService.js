const crypto = require('crypto');
const exifr = require('exifr');
const { Project } = require('../models');
const { haversineDistanceMeters } = require('../utils/geo');
const { isAiConfigured, analyzeWithGemini, parseJsonResponse } = require('./aiClient');
const env = require('../config/env');

const LOCATION_MATCH_RADIUS_M = 2000; // generous — GPS drift + informal addressing in rural areas
const RECENT_WINDOW_MS = 1000 * 60 * 60 * 24 * 3; // 3 days: evidence should reflect a recent site visit, not an old photo

// Kept as a local alias so the rest of this file (and its existing exported
// name, which landDuplicateService used to import) doesn't need to change.
const haversineMeters = haversineDistanceMeters;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Best-effort EXIF read — video files and photos with stripped metadata
 * (common after messaging-app compression) simply yield nulls rather than
 * throwing, since evidence submission must not hard-fail on missing EXIF. */
async function readExif(buffer) {
  try {
    const gps = await exifr.gps(buffer);
    const data = await exifr.parse(buffer, { pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate'] });
    const capturedAt = data?.DateTimeOriginal || data?.CreateDate || data?.ModifyDate || null;
    return {
      lat: gps?.latitude ?? null,
      lng: gps?.longitude ?? null,
      capturedAt: capturedAt ? new Date(capturedAt) : null,
    };
  } catch {
    return { lat: null, lng: null, capturedAt: null };
  }
}

/**
 * Derives the anti-fraud signals the Evidence schema expects
 * (locationMatch, timestampRecent, duplicateFlag) from the actual uploaded
 * bytes, rather than trusting client-supplied values — a client that wants
 * to fake a geotag or timestamp would have to fake the file's EXIF data
 * itself, not just the request body.
 *
 * @param {Buffer} buffer raw file bytes (from multer memory storage)
 * @param {{lat:number,lng:number}|null} projectLocation project's registered site location, if set
 * @param {{lat:number,lng:number}|null} fallbackGeotag device Geolocation reading sent alongside
 *   the file, used only when the file itself carries no GPS EXIF (common for browser file-input
 *   uploads, which often strip it) — weaker than EXIF since it's client-reported, but still
 *   genuine device telemetry rather than a fabricated value.
 */
async function analyzeEvidence(buffer, projectLocation, fallbackGeotag = null) {
  const fileHash = sha256(buffer);
  const exif = await readExif(buffer);

  const geotag = exif.lat != null ? { lat: exif.lat, lng: exif.lng } : fallbackGeotag ?? { lat: null, lng: null };
  const locationMatch =
    geotag.lat != null && geotag.lng != null && projectLocation?.lat != null && projectLocation?.lng != null
      ? haversineMeters(geotag, projectLocation) <= LOCATION_MATCH_RADIUS_M
      : null;

  const timestampRecent = exif.capturedAt ? Date.now() - exif.capturedAt.getTime() <= RECENT_WINDOW_MS : null;

  // The current submission hasn't been saved yet, so any existing match
  // (same project or a different one) is a genuine reused-file signal.
  const duplicateOwner = await Project.findOne({ 'milestones.evidence.fileHash': fileHash }).select('_id').lean();
  const duplicateFlag = Boolean(duplicateOwner);

  return { geotag, fileHash, locationMatch, timestampRecent, duplicateFlag, capturedAt: exif.capturedAt };
}

/**
 * AI second opinion — ONLY called when a heuristic signal already looks off
 * (duplicate hash, geotag mismatch, or stale timestamp). Never runs on clean
 * evidence, to keep cost/latency bounded. Returns null on anything short of
 * a clean, parseable success (AI unconfigured, disabled, call failure, or an
 * unparseable/malformed reply) — the caller must treat null exactly like "no
 * second opinion available" and keep the deterministic flag as-is.
 */
async function getAiSecondOpinion({ analysis, project, milestone, fileUrl, evidenceType }) {
  const heuristicLooksOff = analysis.duplicateFlag || analysis.locationMatch === false || analysis.timestampRecent === false;
  if (!heuristicLooksOff || !env.ai.fraudAnalysisEnabled || !isAiConfigured()) return null;

  const system =
    'You are a fraud-review second opinion for Mboa Trust, an escrow platform that releases milestone ' +
    'payments for verified construction/infrastructure work in Cameroon once proof is submitted. This ' +
    'piece of evidence has already been flagged by deterministic checks below. Give your own independent ' +
    'assessment of whether it looks like genuine on-site proof of the described work, or looks staged, ' +
    'reused, or otherwise untrustworthy. Reply with strict JSON only, no prose, no markdown fences: ' +
    '{"riskScore": <0-100 integer>, "suspicious": <true|false>, "rationale": "<one or two sentences>"}';

  const prompt =
    `Project category: ${project.category || 'unspecified'}\n` +
    `Project description: ${project.description || 'none'}\n` +
    `Milestone: ${milestone.name} — ${milestone.description || 'no description'}\n` +
    `Deterministic signals already triggered: duplicateFlag=${analysis.duplicateFlag}, ` +
    `locationMatch=${analysis.locationMatch}, timestampRecent=${analysis.timestampRecent}\n` +
    `Evidence type: ${evidenceType}`;

  const result = await analyzeWithGemini({
    system,
    prompt,
    imageUrl: evidenceType === 'photo' ? fileUrl : undefined,
  });
  if (!result.ok) return null;

  const parsed = parseJsonResponse(result.text);
  if (!parsed || typeof parsed.riskScore !== 'number') return null;

  return {
    riskScore: Math.max(0, Math.min(100, Math.round(parsed.riskScore))),
    suspicious: Boolean(parsed.suspicious),
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 1000) : '',
  };
}

module.exports = { analyzeEvidence, haversineMeters, sha256, getAiSecondOpinion };
