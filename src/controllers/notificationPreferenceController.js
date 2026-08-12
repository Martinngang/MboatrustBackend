const { NotificationPreference } = require('../models');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { defaultPrefsObject } = require('../utils/notificationCategories');

const getMine = catchAsync(async (req, res) => {
  const pref = await NotificationPreference.findOne({ userId: req.user._id }).lean();
  return ok(res, pref || { userId: req.user._id, prefs: defaultPrefsObject() });
});

/** Body is a partial map — `{ bids: { push: false } }` only touches that one
 * category/channel, everything else on the stored doc is left as-is. */
const updateMine = catchAsync(async (req, res) => {
  const pref = await NotificationPreference.findOneAndUpdate(
    { userId: req.user._id },
    { $setOnInsert: { userId: req.user._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  for (const [category, channels] of Object.entries(req.body)) {
    pref.prefs[category] = { ...(pref.prefs[category] || {}), ...channels };
  }
  // Mixed-type fields need this — Mongoose can't detect a plain in-place
  // property mutation on its own (same reason RiskFlag.detail writes work
  // fine elsewhere in this codebase: they always reassign/markModified too).
  pref.markModified('prefs');
  await pref.save();
  return ok(res, pref);
});

module.exports = { getMine, updateMine };
