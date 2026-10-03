const mongoose = require('mongoose');
const { getIO } = require('./socketRegistry');

/**
 * Live dashboard invalidation. Whenever a document that feeds a dashboard
 * number is written — by any code path: controllers, admin edits, payment
 * webhooks, scripts — every user whose numbers could have changed gets a
 * content-free `dashboard:changed` socket event in their `user:<id>` room,
 * and admins get one in the `role:admin` room. Clients respond by refetching
 * GET /dashboard/:role (see api/realtime.ts on both frontends); the event
 * itself carries no data, so it can never leak anything.
 *
 * This lives at the Mongoose layer rather than in notificationService on
 * purpose: notifications only reach the *recipient* of a notable event, and
 * plenty of stat-changing writes send none at all (an admin correcting a
 * listing, a disbursement settling, a co-funder paying in).
 *
 * Contract: this must never slow down or fail the write it observes. Hooks
 * catch their own errors, affected-user resolution runs after the write
 * returns, and everything is a no-op when no socket server is running
 * (e.g. the standalone cron scripts, where getIO() is null).
 */

const FLUSH_DELAY_MS = 400;
// Safety cap for bulk writes (updateMany/deleteMany) — how many affected
// documents we look up to find their owners before giving up on precision.
const BULK_LOOKUP_LIMIT = 500;

const pendingUserIds = new Set();
let adminDirty = false;
let flushTimer = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function flush() {
  flushTimer = null;
  const io = getIO();
  const userIds = [...pendingUserIds];
  const notifyAdmins = adminDirty;
  pendingUserIds.clear();
  adminDirty = false;
  if (!io) return;
  const payload = { at: Date.now() };
  for (const id of userIds) io.to(`user:${id}`).emit('dashboard:changed', payload);
  if (notifyAdmins) io.to('role:admin').emit('dashboard:changed', { ...payload, scope: 'platform' });
}

function markUsers(ids) {
  for (const id of ids) {
    if (id) pendingUserIds.add(String(id._id ?? id));
  }
  scheduleFlush();
}

function markAdmins() {
  adminDirty = true;
  scheduleFlush();
}

// Lazily required — this module is loaded by models/index.js before any
// model is compiled, so requiring models at the top would be a cycle.
const models = () => require('../models');

async function projectOwner(projectId) {
  if (!projectId) return null;
  const p = await models().Project.findById(projectId).select('ownerId').lean();
  return p?.ownerId ?? null;
}

async function supplierOwner(supplierProfileId) {
  if (!supplierProfileId) return null;
  const s = await models().SupplierProfile.findById(supplierProfileId).select('ownerId').lean();
  return s?.ownerId ?? null;
}

/** For each tracked model: the fields needed to find affected users, and
 * who those users are. Untracked models (messages, notifications, logs…)
 * never trigger anything. */
const TRACKED = {
  Project: {
    fields: '_id ownerId coSignerId projectType',
    // Owner/co-signer (pending reviews, active projects), the awarded
    // contractor (completed jobs), and every funder who paid in (active
    // projects, total funded).
    async resolve(d) {
      const { Bid, Escrow } = models();
      const [accepted, funders] = await Promise.all([
        d.projectType === 'tender' ? Bid.findOne({ projectId: d._id, status: 'accepted' }).select('contractorId').lean() : null,
        Escrow.distinct('funderId', { projectId: d._id, type: 'fund' }),
      ]);
      return [d.ownerId, d.coSignerId, accepted?.contractorId, ...funders];
    },
  },
  Escrow: {
    fields: 'projectId funderId contractorId payeeSupplierId',
    async resolve(d) {
      const [owner, supplier] = await Promise.all([projectOwner(d.projectId), supplierOwner(d.payeeSupplierId)]);
      return [d.funderId, d.contractorId, owner, supplier];
    },
  },
  Bid: {
    fields: 'projectId contractorId',
    // Delegates see their principal's bids in "Active bids" too.
    async resolve(d) {
      const { TeamMember } = models();
      const [owner, delegates] = await Promise.all([
        projectOwner(d.projectId),
        TeamMember.find({ ownerId: d.contractorId, status: 'active', permissions: 'submit_milestones' }).select('userId').lean(),
      ]);
      return [d.contractorId, owner, ...delegates.map((t) => t.userId)];
    },
  },
  LandListing: { fields: 'sellerId', resolve: (d) => [d.sellerId] },
  LandOffer: {
    fields: 'listingId buyerId',
    async resolve(d) {
      const listing = await models().LandListing.findById(d.listingId).select('sellerId').lean();
      return [d.buyerId, listing?.sellerId];
    },
  },
  MaterialOrder: {
    fields: 'supplierId requestedBy',
    async resolve(d) {
      return [d.requestedBy, await supplierOwner(d.supplierId)];
    },
  },
  VerificationTask: { fields: 'verifierId', resolve: (d) => [d.verifierId] },
  Rating: { fields: 'toUserId', resolve: (d) => [d.toUserId] },
  Dispute: { fields: 'raisedBy', resolve: (d) => [d.raisedBy] },
  SupplierProfile: { fields: 'ownerId', resolve: (d) => [d.ownerId] },
  VerifierProfile: { fields: 'userId', resolve: (d) => [d.userId] },
  // Categories decide the contractor's "matching your trade" tender.
  ContractorProfile: { fields: 'userId', resolve: (d) => [d.userId] },
  // Only the admin "Total users" tile depends on users — see userChanged().
  User: { fields: '_id', resolve: () => [] },
};

// User documents are written constantly (sign-in provider sync, profile
// edits…); only these changes move an admin number.
const USER_ADMIN_FIELDS = ['isActive', 'roles'];

function isTracked(modelName) {
  return Boolean(modelName && TRACKED[modelName]) && Boolean(getIO());
}

/** Resolve affected users for already-written docs, off the request path. */
function touch(modelName, docs) {
  if (!isTracked(modelName)) return;
  markAdmins();
  const { resolve } = TRACKED[modelName];
  Promise.all(docs.filter(Boolean).map((d) => Promise.resolve(resolve(d)).then(markUsers)))
    .catch((err) => console.warn(`[dashboardEvents] ${modelName} resolve failed:`, err.message));
}

function updateTouchesUserAdminFields(update) {
  if (!update) return false;
  const keys = Object.keys(update).flatMap((k) => (k.startsWith('$') ? Object.keys(update[k] || {}) : [k]));
  return keys.some((k) => USER_ADMIN_FIELDS.some((f) => k === f || k.startsWith(`${f}.`)));
}

function dashboardEventsPlugin(schema) {
  // ── Document middleware ──
  schema.post('save', function onSave(doc) {
    try {
      // Embedded docs (milestones, evidence…) save with their parent, which
      // already fires its own hook.
      if (doc?.$isSubdocument) return;
      const name = doc?.constructor?.modelName;
      if (name === 'User') {
        if (!isTracked('User')) return;
        // `wasNew` is set by the pre-save hook below; isNew is already false here.
        if (doc.$locals?.dashboardWasNew || USER_ADMIN_FIELDS.some((f) => doc.$locals?.dashboardModified?.includes(f))) markAdmins();
        return;
      }
      touch(name, [doc]);
    } catch (err) {
      console.warn('[dashboardEvents] post-save hook failed:', err.message);
    }
  });
  schema.pre('save', function rememberUserChange() {
    try {
      if (this?.constructor?.modelName !== 'User') return;
      this.$locals.dashboardWasNew = this.isNew;
      this.$locals.dashboardModified = this.modifiedPaths();
    } catch {
      /* never block the save */
    }
  });
  schema.post('deleteOne', { document: true, query: false }, function onDocDelete(doc) {
    try {
      touch(doc?.constructor?.modelName, [doc]);
    } catch (err) {
      console.warn('[dashboardEvents] post-deleteOne hook failed:', err.message);
    }
  });

  // ── Model.insertMany ──
  schema.post('insertMany', function onInsertMany(docs) {
    try {
      touch(this?.modelName, Array.isArray(docs) ? docs : [docs]);
    } catch (err) {
      console.warn('[dashboardEvents] post-insertMany hook failed:', err.message);
    }
  });

  // ── findOneAnd* (the written doc is returned to the hook) ──
  schema.post(['findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace'], function onFindOneAnd(res) {
    try {
      const name = this?.model?.modelName;
      const doc = res && typeof res === 'object' && 'value' in res && 'ok' in res ? res.value : res;
      if (name === 'User') {
        if (isTracked('User') && updateTouchesUserAdminFields(this.getUpdate())) markAdmins();
        return;
      }
      if (doc) touch(name, [doc]);
    } catch (err) {
      console.warn('[dashboardEvents] post-findOneAnd hook failed:', err.message);
    }
  });

  // ── Filter-based writes: find the affected docs first, then emit after ──
  const BULK_OPS = ['updateOne', 'updateMany', 'deleteOne', 'deleteMany'];
  schema.pre(BULK_OPS, { document: false, query: true }, async function captureAffected() {
    try {
      const name = this?.model?.modelName;
      if (!isTracked(name)) return;
      if (name === 'User') {
        const op = this.op;
        this._dashboardAdminOnly = op === 'deleteOne' || op === 'deleteMany' || updateTouchesUserAdminFields(this.getUpdate());
        return;
      }
      this._dashboardAffected = await this.model.find(this.getFilter()).select(TRACKED[name].fields).limit(BULK_LOOKUP_LIMIT).lean();
    } catch (err) {
      console.warn('[dashboardEvents] pre-bulk lookup failed:', err.message);
    }
  });
  schema.post(BULK_OPS, { document: false, query: true }, function emitAffected() {
    try {
      const name = this?.model?.modelName;
      if (name === 'User') {
        if (this._dashboardAdminOnly) markAdmins();
        return;
      }
      if (this._dashboardAffected?.length) touch(name, this._dashboardAffected);
      // An upsert that inserted a new doc matched nothing beforehand.
      else if (isTracked(name)) markAdmins();
    } catch (err) {
      console.warn('[dashboardEvents] post-bulk hook failed:', err.message);
    }
  });
}

let registered = false;
/** Must run before any model is compiled — models/index.js calls it first. */
function registerPlugin() {
  if (registered) return;
  registered = true;
  mongoose.plugin(dashboardEventsPlugin);
}

module.exports = { registerPlugin, flush };
