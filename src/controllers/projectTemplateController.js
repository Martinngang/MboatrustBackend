const { ProjectTemplate } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

// Hand-rolled rather than controllerFactory.buildCrud — that factory's
// generic getAll/update/remove have no ownership scoping (it's designed for
// admin-facing resources), which would let any authenticated user read or
// delete another user's templates by guessing an id.

const getMine = catchAsync(async (req, res) => {
  const templates = await ProjectTemplate.find({ ownerId: req.user._id }).sort('-createdAt');
  return ok(res, templates);
});

const create = catchAsync(async (req, res) => {
  const template = await ProjectTemplate.create({ ...req.body, ownerId: req.user._id });
  return created(res, template);
});

const remove = catchAsync(async (req, res) => {
  const template = await ProjectTemplate.findById(req.params.id);
  if (!template) throw ApiError.notFound('Template not found');
  if (String(template.ownerId) !== String(req.user._id)) throw ApiError.forbidden();
  await template.deleteOne();
  return res.status(204).send();
});

module.exports = { getMine, create, remove };
