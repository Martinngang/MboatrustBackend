const { MaterialOrder, Project, Bid, QuincaillerieProfile } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

async function requireMyQuincaillerieId(userId) {
  const profile = await QuincaillerieProfile.findOne({ ownerId: userId }).select('_id');
  if (!profile) throw ApiError.badRequest('Register a quincaillerie before managing orders');
  return profile._id;
}

/** Who is this user to this project — the project owner (funder for a
 * tender, recipient for a funding project) or the contractor whose bid was
 * accepted (tender-only; a funding project has no bids at all). Mirrors the
 * `$or` party-check shape contractController.getAll/bidController.getAll
 * already use for scoping party-only reads, computed once here since
 * multiple actions below need it. */
async function getProjectParty(project, userId) {
  const isOwner = String(project.ownerId) === String(userId);
  let isAwardedContractor = false;
  if (project.projectType === 'tender') {
    const acceptedBid = await Bid.findOne({ projectId: project._id, contractorId: userId, status: 'accepted' })
      .select('_id')
      .lean();
    isAwardedContractor = Boolean(acceptedBid);
  }
  return { isOwner, isAwardedContractor, isParty: isOwner || isAwardedContractor };
}

async function loadProjectAndMilestone(projectId, milestoneId) {
  const project = await Project.findById(projectId);
  if (!project) throw ApiError.notFound('Project not found');
  const milestone = project.milestones.id(milestoneId);
  if (!milestone) throw ApiError.notFound('Milestone not found on this project');
  return { project, milestone };
}

function computeTotals(items) {
  return items.map((item) => ({ ...item, subtotal: Math.round(item.quantity * item.unitPrice * 100) / 100 }));
}

/** Every response below hands this order to a screen that needs to *display*
 * it — a store name, a project title, a milestone name, who asked for it —
 * not just its raw ids. Populating here (once, in one place) keeps every
 * list/mutation response self-sufficient, instead of forcing the frontend to
 * cross-reference three other queries just to render one order card. */
const DISPLAY_POPULATE = [
  { path: 'projectId', select: 'title milestones' },
  { path: 'quincaillerieId', select: 'businessName' },
  { path: 'requestedBy', select: 'fullName' },
  { path: 'deliveryConfirmation.confirmedBy', select: 'fullName' },
];

// The array form works identically on a Query (find/findById, not yet
// executed — returns the query for chaining/awaiting) and on a Document
// instance (already fetched or just .save()'d — mutates and resolves to
// itself), so every call site below can use this one helper regardless of
// which it's holding.
async function withDisplay(orderOrQuery) {
  return orderOrQuery.populate(DISPLAY_POPULATE);
}

/** Funder or contractor requesting materials for one of their own project's
 * milestones — the entry point both required end-to-end paths (Funder →
 * Quincaillerie → Project, Contractor → Quincaillerie → Project) share.
 * Only a real party to the project may request, and only against an
 * approved, real quincaillerie. */
const create = catchAsync(async (req, res) => {
  const { projectId, milestoneId, quincaillerieId, items, deliveryAddress } = req.body;
  const { project } = await loadProjectAndMilestone(projectId, milestoneId);

  const party = await getProjectParty(project, req.user._id);
  if (!party.isParty) throw ApiError.forbidden('Not a party to this project');

  const quincaillerie = await QuincaillerieProfile.findById(quincaillerieId).select('_id applicationStatus');
  if (!quincaillerie) throw ApiError.notFound('Quincaillerie not found');
  if (quincaillerie.applicationStatus !== 'approved') throw ApiError.badRequest('This quincaillerie is not approved yet');

  const itemsWithSubtotals = computeTotals(items);
  const totalAmount = itemsWithSubtotals.reduce((sum, i) => sum + i.subtotal, 0);

  const order = await MaterialOrder.create({
    projectId,
    milestoneId,
    quincaillerieId,
    requestedBy: req.user._id,
    items: itemsWithSubtotals,
    totalAmount,
    deliveryAddress: deliveryAddress || '',
  });
  await withDisplay(order);
  return created(res, order);
});

/** The requester's own orders, across every project — "my requests" list. */
const getMine = catchAsync(async (req, res) => {
  const orders = await withDisplay(MaterialOrder.find({ requestedBy: req.user._id }).sort('-createdAt'));
  return ok(res, orders);
});

/** Incoming orders for the caller's own quincaillerie — the store owner's
 * dashboard queue. */
const getForMyQuincaillerie = catchAsync(async (req, res) => {
  const myQuincaillerieId = await requireMyQuincaillerieId(req.user._id);
  const { status } = req.query;
  const filter = { quincaillerieId: myQuincaillerieId };
  if (status && status !== 'all') filter.status = status;
  const orders = await withDisplay(MaterialOrder.find(filter).sort('-createdAt'));
  return ok(res, orders);
});

/** Every order tied to one milestone, visible to any real party of that
 * project (owner, awarded contractor) or the fulfilling quincaillerie's
 * owner — never to an unrelated user, even one who knows the milestone id. */
const getForMilestone = catchAsync(async (req, res) => {
  const { projectId, milestoneId } = req.params;
  const { project } = await loadProjectAndMilestone(projectId, milestoneId);
  const party = await getProjectParty(project, req.user._id);

  const orders = await withDisplay(MaterialOrder.find({ projectId, milestoneId }).sort('-createdAt'));
  if (party.isParty) return ok(res, orders);

  const myQuincaillerieId = await QuincaillerieProfile.findOne({ ownerId: req.user._id }).select('_id').lean();
  const visible = myQuincaillerieId
    ? orders.filter((o) => String(o.quincaillerieId._id) === String(myQuincaillerieId._id))
    : [];
  if (visible.length === 0 && orders.length > 0) throw ApiError.forbidden('Not a party to this order');
  return ok(res, visible);
});

async function loadOwnedOrder(orderId, userId) {
  const order = await MaterialOrder.findById(orderId);
  if (!order) throw ApiError.notFound('Order not found');
  const myQuincaillerieId = await requireMyQuincaillerieId(userId);
  if (!order.quincaillerieId.equals(myQuincaillerieId)) throw ApiError.forbidden('Not your order');
  return order;
}

/** Quincaillerie owner confirms availability — may adjust items/pricing to
 * reflect real current stock/price rather than accepting the request as-is
 * (same "confirmation can correct the ask" shape a bid negotiation has). */
const confirm = catchAsync(async (req, res) => {
  const order = await loadOwnedOrder(req.params.id, req.user._id);
  if (order.status !== 'requested') throw ApiError.badRequest(`Cannot confirm an order in status "${order.status}"`);

  const { items, deliveryAddress, estimatedDeliveryDate } = req.body;
  if (items) {
    order.items = computeTotals(items);
    order.totalAmount = order.items.reduce((sum, i) => sum + i.subtotal, 0);
  }
  if (deliveryAddress !== undefined) order.deliveryAddress = deliveryAddress;
  if (estimatedDeliveryDate !== undefined) order.estimatedDeliveryDate = estimatedDeliveryDate;
  order.status = 'confirmed';
  order.confirmedAt = new Date();
  await order.save();
  await withDisplay(order);
  return ok(res, order);
});

const reject = catchAsync(async (req, res) => {
  const order = await loadOwnedOrder(req.params.id, req.user._id);
  if (order.status !== 'requested') throw ApiError.badRequest(`Cannot reject an order in status "${order.status}"`);
  order.status = 'rejected';
  order.rejectionReason = req.body.reason;
  await order.save();
  await withDisplay(order);
  return ok(res, order);
});

const markOutForDelivery = catchAsync(async (req, res) => {
  const order = await loadOwnedOrder(req.params.id, req.user._id);
  if (order.status !== 'confirmed') throw ApiError.badRequest(`Cannot dispatch an order in status "${order.status}"`);
  order.status = 'out_for_delivery';
  await order.save();
  await withDisplay(order);
  return ok(res, order);
});

/** Confirmed by any real party of the underlying project (owner or awarded
 * contractor) — whoever is physically on-site to receive the delivery, not
 * necessarily the exact person who originally requested it. Bumps the
 * quincaillerie's completedOrderCount, the same denormalized-stat-on-event
 * convention QuincaillerieProfile already carries for ratings. */
const confirmDelivery = catchAsync(async (req, res) => {
  const order = await MaterialOrder.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  const project = await Project.findById(order.projectId);
  if (!project) throw ApiError.notFound('Project not found');
  const party = await getProjectParty(project, req.user._id);
  if (!party.isParty) throw ApiError.forbidden('Not a party to this project');
  if (!['confirmed', 'out_for_delivery'].includes(order.status)) {
    throw ApiError.badRequest(`Cannot confirm delivery for an order in status "${order.status}"`);
  }

  const { geotagLat, geotagLng } = req.body;
  order.status = 'delivered';
  order.deliveryConfirmation = {
    geotag: { lat: geotagLat ?? null, lng: geotagLng ?? null },
    timestamp: new Date(),
    confirmedBy: req.user._id,
  };
  await order.save();
  await QuincaillerieProfile.updateOne({ _id: order.quincaillerieId }, { $inc: { completedOrderCount: 1 } });
  await withDisplay(order);
  return ok(res, order);
});

/** Requester or the project owner may cancel, and only before the store has
 * acted on it — once confirmed/dispatched, cancelling unilaterally would
 * leave the quincaillerie holding materials it already committed to. */
const cancel = catchAsync(async (req, res) => {
  const order = await MaterialOrder.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  const project = await Project.findById(order.projectId).select('ownerId');
  const isRequester = String(order.requestedBy) === String(req.user._id);
  const isProjectOwner = project && String(project.ownerId) === String(req.user._id);
  if (!isRequester && !isProjectOwner) throw ApiError.forbidden('Not authorized to cancel this order');
  if (order.status !== 'requested') throw ApiError.badRequest(`Cannot cancel an order in status "${order.status}"`);
  order.status = 'cancelled';
  await order.save();
  await withDisplay(order);
  return ok(res, order);
});

module.exports = {
  create,
  getMine,
  getForMyQuincaillerie,
  getForMilestone,
  confirm,
  reject,
  markOutForDelivery,
  confirmDelivery,
  cancel,
};
