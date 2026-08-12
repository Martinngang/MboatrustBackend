const { Schema, model } = require('mongoose');
const { defaultPrefsObject } = require('../utils/notificationCategories');

const NotificationPreferenceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    // Plain object keyed by one of utils/notificationCategories.CATEGORIES,
    // each value `{push, email}` — Mixed rather than a Mongoose Map:
    // Maps-of-subdocument-schema have real, confirmed casting/change-
    // detection issues in this Mongoose version (a plain-object .set() call
    // silently failed to persist even with markModified()); Mixed + this
    // codebase's existing markModified-before-save pattern (see RiskFlag.detail)
    // is the reliable path already proven elsewhere in this backend.
    prefs: { type: Schema.Types.Mixed, default: defaultPrefsObject },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

module.exports = model('NotificationPreference', NotificationPreferenceSchema);
