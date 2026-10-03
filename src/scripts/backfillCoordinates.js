// One-off data migration: geocodes every existing Project/LandListing/
// SupplierProfile/ContractorProfile that has a resolvable text location but
// no real coordinates yet (null, or — for SupplierProfile specifically —
// the old {0,0} default this migration also treats as "unset"; see
// SupplierProfile.js). Existing records predate the auto-geocode-on-create
// logic added alongside this script (see projectController.create,
// landListingController.create, supplierProfileController.upsertMine,
// contractorProfileController.upsertMine) — this is what backfills them.
//
// Sequential, not parallel: geocodingService.forwardGeocode throttles
// itself to Nominatim's ~1 req/sec policy internally, but running many
// calls concurrently would still burst past that before the throttle can
// space them out. A large backlog is expected to take a while — that's
// normal, not a bug.
//
// Idempotent: only matches documents currently missing coordinates, so a
// second run only touches whatever the first run couldn't resolve.
//
// Usage: node src/scripts/backfillCoordinates.js [--dry-run]
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { Project, LandListing, SupplierProfile, ContractorProfile } = require('../models');
const geocodingService = require('../services/geocodingService');

const DRY_RUN = process.argv.includes('--dry-run');

const summary = { geocoded: 0, skipped: 0, failed: 0 };

function isUnset(loc) {
  if (!loc) return true;
  const { lat, lng } = loc;
  if (lat == null || lng == null) return true;
  // SupplierProfile's old default — see the model's own comment.
  if (lat === 0 && lng === 0) return true;
  return false;
}

async function backfillOne(label, doc, query, applyFn) {
  if (!query) {
    console.log(`[skip] ${label} — no resolvable text field`);
    summary.skipped += 1;
    return;
  }
  const resolved = await geocodingService.forwardGeocode(query);
  if (!resolved) {
    console.log(`[fail] ${label} — geocoding "${query}" found nothing`);
    summary.failed += 1;
    return;
  }
  console.log(`[${DRY_RUN ? 'would-geocode' : 'geocoded'}] ${label} — "${query}" -> ${resolved.lat}, ${resolved.lng}`);
  summary.geocoded += 1;
  if (!DRY_RUN) await applyFn(resolved);
}

// Same auto_detected `locationDetails` shape projectController.create/
// landListingController.create now set on a fresh forward-geocode — this
// backfill never leaves an old record's coordinates without one either.
function locationDetailsFrom(resolved) {
  return {
    placeName: resolved.placeName || '',
    formattedAddress: resolved.formattedAddress || '',
    source: 'auto_detected',
    resolvedAt: new Date(),
  };
}

async function run() {
  await connectDB();
  console.log(`[backfill] starting${DRY_RUN ? ' (dry run — no writes)' : ''}...\n`);

  const projects = await Project.find({}).select('_id title locationName location').lean();
  for (const p of projects) {
    if (!isUnset(p.location)) continue;
    await backfillOne(`Project "${p.title}" (${p._id})`, p, p.locationName || null, (resolved) =>
      Project.updateOne(
        { _id: p._id },
        { $set: { location: { lat: resolved.lat, lng: resolved.lng }, locationDetails: locationDetailsFrom(resolved) } }
      )
    );
  }

  const listings = await LandListing.find({}).select('_id title city region location').lean();
  for (const l of listings) {
    if (!isUnset(l.location)) continue;
    const query = [l.city, l.region, 'Cameroon'].filter(Boolean).join(', ');
    await backfillOne(`LandListing "${l.title}" (${l._id})`, l, l.city || l.region ? query : null, (resolved) =>
      LandListing.updateOne(
        { _id: l._id },
        { $set: { location: { lat: resolved.lat, lng: resolved.lng }, locationDetails: locationDetailsFrom(resolved) } }
      )
    );
  }

  const suppliers = await SupplierProfile.find({}).select('_id businessName address region location').lean();
  for (const s of suppliers) {
    if (!isUnset(s.location)) continue;
    const query = [s.address, s.region, 'Cameroon'].filter(Boolean).join(', ');
    await backfillOne(`SupplierProfile "${s.businessName}" (${s._id})`, s, s.address || s.region ? query : null, (resolved) =>
      SupplierProfile.updateOne({ _id: s._id }, { $set: { location: { lat: resolved.lat, lng: resolved.lng } } })
    );
  }

  const contractors = await ContractorProfile.find({}).select('_id userId regions location').lean();
  for (const c of contractors) {
    if (!isUnset(c.location)) continue;
    const query = c.regions?.length ? `${c.regions[0]}, Cameroon` : null;
    await backfillOne(`ContractorProfile for user ${c.userId} (${c._id})`, c, query, (resolved) =>
      ContractorProfile.updateOne({ _id: c._id }, { $set: { location: { lat: resolved.lat, lng: resolved.lng } } })
    );
  }

  console.log(`\n[backfill] done. geocoded=${summary.geocoded} skipped=${summary.skipped} failed=${summary.failed}`);
  if (DRY_RUN) console.log('[backfill] this was a dry run — nothing was written. Re-run without --dry-run to apply.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
