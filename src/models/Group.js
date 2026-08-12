const { Schema, model } = require('mongoose');

const GroupSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // What the group is pooling toward, in the member's own words — not an
    // enum, matching the free-string style of Project.category elsewhere.
    purpose: { type: String, default: '' },
    // Nullable — a group can exist (and gather members) before it has a
    // specific project attached to pool money into.
    linkedProjectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

module.exports = model('Group', GroupSchema);
