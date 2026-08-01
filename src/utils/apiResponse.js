function ok(res, data, meta = undefined, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data, ...(meta ? { meta } : {}) });
}

function created(res, data) {
  return ok(res, data, undefined, 201);
}

module.exports = { ok, created };
