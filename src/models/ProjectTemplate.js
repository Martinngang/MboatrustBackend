const { Schema, model } = require('mongoose');

// Deliberately its own vocabulary, not a reuse of Project's milestone
// subschema — that one carries runtime-only fields (status, evidence,
// approvers, orderIndex...) that have no meaning in a reusable template.
const TemplateMilestoneSchema = new Schema(
  {
    title: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    description: { type: String, default: '' },
  },
  { _id: false }
);

const ProjectTemplateSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, default: '' },
    milestones: { type: [TemplateMilestoneSchema], default: [] },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

ProjectTemplateSchema.index({ ownerId: 1 });

module.exports = model('ProjectTemplate', ProjectTemplateSchema);
