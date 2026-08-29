const { InventoryItem, QuincaillerieProfile } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const storageService = require('../services/storageService');

async function requireMyQuincaillerieId(userId) {
  const profile = await QuincaillerieProfile.findOne({ ownerId: userId }).select('_id');
  if (!profile) throw ApiError.badRequest('Register a quincaillerie before managing inventory');
  return profile._id;
}

/** Owner-only, any item — used by every mutating action below to make sure
 * one quincaillerie can never read/edit/delete another's product. */
async function loadOwnedItem(itemId, userId) {
  const item = await InventoryItem.findById(itemId);
  if (!item) throw ApiError.notFound('Inventory item not found');
  const myQuincaillerieId = await requireMyQuincaillerieId(userId);
  if (!item.quincaillerieId.equals(myQuincaillerieId)) throw ApiError.forbidden('Not your inventory item');
  return item;
}

function buildFilter({ quincaillerieId, search, category, subcategory, status, lowStockOnly }) {
  const filter = { quincaillerieId };
  if (status && status !== 'all') filter.status = status;
  if (category) filter.category = category;
  if (subcategory) filter.subcategory = subcategory;
  if (search) filter.$text = { $search: String(search) };
  if (lowStockOnly === 'true' || lowStockOnly === true) {
    filter.$expr = { $lte: ['$quantityAvailable', '$minStockLevel'] };
  }
  return filter;
}

const SORT_FIELDS = new Set(['name', 'price', 'quantityAvailable', 'createdAt', 'updatedAt', 'category']);

function buildSort(sortBy, sortDir) {
  const field = SORT_FIELDS.has(sortBy) ? sortBy : 'name';
  return { [field]: sortDir === 'desc' ? -1 : 1 };
}

/** Adds a computed, never-stored isLowStock flag — trivial from the raw
 * fields, but computing it once here keeps every list-rendering screen
 * from re-deriving the same comparison. */
function withLowStockFlag(doc) {
  const obj = doc.toObject ? doc.toObject() : doc;
  return { ...obj, isLowStock: obj.quantityAvailable <= obj.minStockLevel };
}

/** Owner's own full catalogue — every status, filterable/searchable/
 * sortable/paginated. The only place a quincaillerie manages its products. */
const getMine = catchAsync(async (req, res) => {
  const myQuincaillerieId = await requireMyQuincaillerieId(req.user._id);
  const { page = 1, limit = 24, search, category, subcategory, status, lowStockOnly, sortBy, sortDir } = req.query;
  const filter = buildFilter({ quincaillerieId: myQuincaillerieId, search, category, subcategory, status, lowStockOnly });

  const [items, total] = await Promise.all([
    InventoryItem.find(filter)
      .sort(buildSort(sortBy, sortDir))
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    InventoryItem.countDocuments(filter),
  ]);
  return ok(res, items.map(withLowStockFlag), { page: Number(page), limit: Number(limit), total });
});

/** Authenticated (any role), active-only — a funder/recipient/contractor
 * browsing a specific store's catalogue to request materials on a
 * milestone. Never exposes archived items outside the owner's own view. */
const getByQuincaillerie = catchAsync(async (req, res) => {
  const { page = 1, limit = 48, search, category, subcategory, sortBy, sortDir } = req.query;
  const filter = buildFilter({ quincaillerieId: req.params.quincaillerieId, search, category, subcategory, status: 'active' });

  const [items, total] = await Promise.all([
    InventoryItem.find(filter)
      .sort(buildSort(sortBy, sortDir))
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    InventoryItem.countDocuments(filter),
  ]);
  return ok(res, items.map(withLowStockFlag), { page: Number(page), limit: Number(limit), total });
});

/** Every active item across every quincaillerie, platform-wide — feeds the
 * Material Cost Estimator's live-pricing comparison (cross-referenced with
 * the quincaillerie directory for region/verification client-side). No
 * pagination: this is a lightweight aggregate read, not a browsing UI. */
const getPublicActive = catchAsync(async (_req, res) => {
  const items = await InventoryItem.find({ status: 'active' }).limit(2000);
  return ok(res, items.map(withLowStockFlag));
});

const getOne = catchAsync(async (req, res) => {
  const item = await loadOwnedItem(req.params.id, req.user._id);
  return ok(res, withLowStockFlag(item));
});

const create = catchAsync(async (req, res) => {
  const myQuincaillerieId = await requireMyQuincaillerieId(req.user._id);
  const existingImages = req.body.existingImages ?? [];
  const uploaded = req.files?.length
    ? await Promise.all(req.files.map((f) => storageService.uploadBuffer(f.buffer, { folder: `mboatrust/inventory/${myQuincaillerieId}` })))
    : [];
  const { existingImages: _drop, ...rest } = req.body;
  const item = await InventoryItem.create({
    ...rest,
    quincaillerieId: myQuincaillerieId,
    images: [...existingImages, ...uploaded.map((u) => u.secure_url)],
  });
  return created(res, withLowStockFlag(item));
});

const update = catchAsync(async (req, res) => {
  const item = await loadOwnedItem(req.params.id, req.user._id);
  const existingImages = req.body.existingImages;
  const uploaded = req.files?.length
    ? await Promise.all(req.files.map((f) => storageService.uploadBuffer(f.buffer, { folder: `mboatrust/inventory/${item.quincaillerieId}` })))
    : [];
  const { existingImages: _drop, ...rest } = req.body;
  Object.assign(item, rest);
  if (existingImages !== undefined || uploaded.length > 0) {
    item.images = [...(existingImages ?? item.images), ...uploaded.map((u) => u.secure_url)];
  }
  await item.save();
  return ok(res, withLowStockFlag(item));
});

/** Clones every field except identity/stats — a duplicated product is its
 * own new item, not a shared reference, and starts at zero stock rather
 * than silently doubling the original's on-hand count. */
const duplicate = catchAsync(async (req, res) => {
  const original = await loadOwnedItem(req.params.id, req.user._id);
  const clone = await InventoryItem.create({
    quincaillerieId: original.quincaillerieId,
    name: `${original.name} (Copy)`,
    sku: original.sku,
    category: original.category,
    subcategory: original.subcategory,
    description: original.description,
    images: original.images,
    unit: original.unit,
    price: original.price,
    quantityAvailable: 0,
    minStockLevel: original.minStockLevel,
    brand: original.brand,
    supplier: original.supplier,
    specifications: original.specifications,
    dimensions: original.dimensions,
    projectSuitability: original.projectSuitability,
    status: 'active',
  });
  return created(res, withLowStockFlag(clone));
});

const archive = catchAsync(async (req, res) => {
  const item = await loadOwnedItem(req.params.id, req.user._id);
  item.status = 'archived';
  await item.save();
  return ok(res, withLowStockFlag(item));
});

const restore = catchAsync(async (req, res) => {
  const item = await loadOwnedItem(req.params.id, req.user._id);
  item.status = 'active';
  await item.save();
  return ok(res, withLowStockFlag(item));
});

const remove = catchAsync(async (req, res) => {
  const item = await loadOwnedItem(req.params.id, req.user._id);
  await item.deleteOne();
  return ok(res, { success: true });
});

/** One request, many items — archive/restore/delete a whole selection at
 * once. Scoped with quincaillerieId in the filter (not just an $in on ids)
 * so a malicious/mistaken id list can never touch another store's items. */
const bulk = catchAsync(async (req, res) => {
  const myQuincaillerieId = await requireMyQuincaillerieId(req.user._id);
  const { ids, action } = req.body;
  const filter = { _id: { $in: ids }, quincaillerieId: myQuincaillerieId };

  if (action === 'delete') {
    const result = await InventoryItem.deleteMany(filter);
    return ok(res, { matched: result.deletedCount });
  }
  const status = action === 'archive' ? 'archived' : 'active';
  const result = await InventoryItem.updateMany(filter, { $set: { status } });
  return ok(res, { matched: result.modifiedCount });
});

module.exports = { getMine, getByQuincaillerie, getPublicActive, getOne, create, update, duplicate, archive, restore, remove, bulk };
