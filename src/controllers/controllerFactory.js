const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

/**
 * Generic CRUD handlers for a Mongoose model. Resource controllers spread
 * these in and override/extend with resource-specific business logic
 * (state transitions, side effects) rather than reimplementing plain CRUD.
 */
function buildCrud(Model, { defaultSort = '-createdAt', searchableFilters = [] } = {}) {
  const getAll = catchAsync(async (req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const filter = {};
    for (const key of searchableFilters) {
      if (req.query[key] !== undefined) filter[key] = req.query[key];
    }

    const [items, total] = await Promise.all([
      Model.find(filter)
        .sort(defaultSort)
        .skip((page - 1) * limit)
        .limit(Number(limit)),
      Model.countDocuments(filter),
    ]);

    return ok(res, items, { page: Number(page), limit: Number(limit), total });
  });

  const getOne = catchAsync(async (req, res) => {
    const doc = await Model.findById(req.params.id);
    if (!doc) throw ApiError.notFound(`${Model.modelName} not found`);
    return ok(res, doc);
  });

  const create = catchAsync(async (req, res) => {
    const doc = await Model.create(req.body);
    return created(res, doc);
  });

  const update = catchAsync(async (req, res) => {
    const doc = await Model.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!doc) throw ApiError.notFound(`${Model.modelName} not found`);
    return ok(res, doc);
  });

  const remove = catchAsync(async (req, res) => {
    const doc = await Model.findByIdAndDelete(req.params.id);
    if (!doc) throw ApiError.notFound(`${Model.modelName} not found`);
    return res.status(204).send();
  });

  return { getAll, getOne, create, update, remove };
}

module.exports = { buildCrud };
