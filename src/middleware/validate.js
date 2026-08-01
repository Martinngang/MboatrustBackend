const ApiError = require('../utils/ApiError');

/**
 * Validates req[source] against a Zod schema, replacing it with the
 * parsed (and type-coerced) value on success.
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(ApiError.badRequest('Validation failed', result.error.flatten()));
    }
    req[source] = result.data;
    next();
  };
}

module.exports = validate;
