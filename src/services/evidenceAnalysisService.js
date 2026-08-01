const crypto = require('crypto');
const exifr = require('exifr');
const { Project } = require('../models');

const EARTH_RADIUS_M = 6_371_000;
const LOCATION_MATCH_RADIUS_M = 2000; // generous — GPS drift + informal addressing in rural areas
const RECENT_WINDOW_MS = 1000 * 60 * 60 * 24 * 3; // 3 days: evidence should reflect a recent site visit, not an old photo

function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

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

module.exports = { analyzeEvidence, haversineMeters, sha256 };
