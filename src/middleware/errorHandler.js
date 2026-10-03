const ApiError = require('../utils/ApiError');

function notFoundHandler(req, res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let { statusCode, message, details } = err;

  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = err.message;
  } else if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid ${err.path}: ${err.value}`;
  } else if (err.name === 'BSONError') {
    // Raised by `new mongoose.Types.ObjectId(badString)` — code that builds
    // an ObjectId by hand (aggregation $match, stats services) bypasses
    // Mongoose's own CastError, so a malformed id in the URL used to surface
    // as a 500 with a stack trace instead of the 400 a bad id deserves.
    statusCode = 400;
    message = 'Invalid id';
  } else if (err.code === 11000) {
    statusCode = 409;
    message = `Duplicate value for: ${Object.keys(err.keyValue || {}).join(', ')}`;
  }

  if (!statusCode) statusCode = 500;
  if (statusCode === 500) {
    console.error(err);
    message = 'Internal server error';
  }

  res.status(statusCode).json({
    success: false,
    error: { message, details: details || undefined },
  });
}

module.exports = { notFoundHandler, errorHandler };
