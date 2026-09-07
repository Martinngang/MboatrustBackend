const { HelpArticle } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { buildCrud } = require('./controllerFactory');

const crud = buildCrud(HelpArticle, { searchableFilters: ['category', 'isPublished'] });

function isAdminUser(user) {
  return Boolean(user.roles?.some((r) => r.roleType === 'admin'));
}

/**
 * Non-admins only ever see published articles; admins (managing FAQ
 * content) see everything and can filter by `isPublished` explicitly.
 * `q` triggers the Mongo text index across question/answer/tags — plain
 * `category` filtering skips it entirely since a $text query can't be
 * combined with a category-only scan any more cheaply than a plain find.
 */
const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 50, category, q } = req.query;
  const admin = isAdminUser(req.user);
  const filter = {};
  if (!admin) filter.isPublished = true;
  else if (req.query.isPublished !== undefined) filter.isPublished = req.query.isPublished === 'true';
  if (category) filter.category = category;
  if (q) filter.$text = { $search: q };

  const [items, total] = await Promise.all([
    HelpArticle.find(filter)
      .sort(q ? { score: { $meta: 'textScore' } } : { category: 1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    HelpArticle.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getOne = catchAsync(async (req, res) => {
  const article = await HelpArticle.findById(req.params.id);
  if (!article) throw ApiError.notFound('Help article not found');
  if (!article.isPublished && !isAdminUser(req.user)) throw ApiError.notFound('Help article not found');
  return ok(res, article);
});

module.exports = { ...crud, getAll, getOne };
