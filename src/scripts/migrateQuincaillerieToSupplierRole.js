// One-off data migration: renames every persisted 'quincaillerie' role/
// field/enum value to 'supplier' across the collections that referenced it.
//
// Runs via raw db.collection(...).updateMany() calls, bypassing Mongoose
// schema validation entirely — by the time this runs, the application's
// schemas (User, InventoryItem, MaterialOrder, Project, Escrow) already only
// recognize the new field/enum names, but documents already in the database
// still have the old ones. Loading an old-shaped document through the new
// Mongoose schema and calling .save() would either silently drop the
// unrecognized old field (never renaming it) or throw a ValidationError on
// the still-present old enum value before any rename could happen — raw
// MongoDB update operators sidestep both problems for this one-off rewrite.
//
// The SupplierProfile collection itself is NOT renamed here — its physical
// collection name ('quincaillerieprofiles') is intentionally kept and pinned
// in models/SupplierProfile.js, so there is nothing to migrate for it.
//
// Idempotent: every filter below only matches documents still in the old
// shape, so a second run matches and modifies zero documents everywhere.
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');

async function run() {
  await connectDB();
  const db = mongoose.connection.db;

  console.log("[migrate] User.roles: 'quincaillerie' -> 'supplier'");
  const usersRes = await db.collection('users').updateMany(
    { 'roles.roleType': 'quincaillerie' },
    { $set: { 'roles.$[elem].roleType': 'supplier' } },
    { arrayFilters: [{ 'elem.roleType': 'quincaillerie' }] }
  );
  console.log(`[migrate] users modified: ${usersRes.modifiedCount}`);

  console.log('[migrate] InventoryItem.quincaillerieId -> supplierId');
  const invRes = await db.collection('inventoryitems').updateMany(
    { quincaillerieId: { $exists: true } },
    { $rename: { quincaillerieId: 'supplierId' } }
  );
  console.log(`[migrate] inventory items renamed: ${invRes.modifiedCount}`);

  console.log('[migrate] MaterialOrder.quincaillerieId -> supplierId');
  const orderRes = await db.collection('materialorders').updateMany(
    { quincaillerieId: { $exists: true } },
    { $rename: { quincaillerieId: 'supplierId' } }
  );
  console.log(`[migrate] material orders renamed: ${orderRes.modifiedCount}`);

  console.log("[migrate] Project.preferredQuincaillerieId -> preferredSupplierId, materialsManagedBy 'quincaillerie' -> 'supplier'");
  const projRenameRes = await db.collection('projects').updateMany(
    { preferredQuincaillerieId: { $exists: true } },
    { $rename: { preferredQuincaillerieId: 'preferredSupplierId' } }
  );
  const projEnumRes = await db.collection('projects').updateMany(
    { materialsManagedBy: 'quincaillerie' },
    { $set: { materialsManagedBy: 'supplier' } }
  );
  console.log(`[migrate] projects field-renamed: ${projRenameRes.modifiedCount}, enum-updated: ${projEnumRes.modifiedCount}`);

  console.log("[migrate] Escrow.payeeQuincaillerieId -> payeeSupplierId, payeeType 'quincaillerie' -> 'supplier'");
  const escrowRenameRes = await db.collection('escrows').updateMany(
    { payeeQuincaillerieId: { $exists: true } },
    { $rename: { payeeQuincaillerieId: 'payeeSupplierId' } }
  );
  const escrowEnumRes = await db.collection('escrows').updateMany(
    { payeeType: 'quincaillerie' },
    { $set: { payeeType: 'supplier' } }
  );
  console.log(`[migrate] escrows field-renamed: ${escrowRenameRes.modifiedCount}, enum-updated: ${escrowEnumRes.modifiedCount}`);

  await mongoose.disconnect();
  console.log('[migrate] done');
}

run().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
