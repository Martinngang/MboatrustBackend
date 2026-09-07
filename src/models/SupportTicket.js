const { Schema, model } = require('mongoose');
const { SUPPORT_CATEGORIES } = require('../utils/supportCategories');

const AttachmentSchema = new Schema(
  {
    url: { type: String, required: true },
    type: { type: String, default: 'file' },
    mimeType: { type: String, default: '' },
    fileName: { type: String, default: '' },
    sizeBytes: { type: Number, default: 0 },
  },
  { _id: false }
);

const ResponseSchema = new Schema(
  {
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    isAdmin: { type: Boolean, required: true },
    message: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const SupportTicketSchema = new Schema(
  {
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['bug_report', 'feedback', 'question', 'contact_support'], required: true },
    category: { type: String, enum: SUPPORT_CATEGORIES, default: 'other' },
    subject: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    attachments: { type: [AttachmentSchema], default: [] },
    // Auto-captured by the client at the moment the submission form is
    // opened (see FeedbackModal.tsx / FeedbackSheet.tsx) and shown to the
    // user as a removable chip before submit — never attached silently.
    context: {
      platform: { type: String, enum: ['web', 'mobile'] },
      screen: { type: String, default: '' },
      screenLabel: { type: String, default: '' },
      feature: { type: String, default: '' },
      appVersion: { type: String, default: '' },
    },
    status: { type: String, enum: ['open', 'in_progress', 'resolved', 'closed'], default: 'open' },
    // Admin-only — never set by the submitter (see controller), defaulted
    // from `type` at creation.
    priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
    // Triage ownership. Null means "in the unassigned queue" — with more
    // than one admin on the rota, an unowned ticket is the one that silently
    // goes unanswered because everyone assumes someone else has it.
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    responses: { type: [ResponseSchema], default: [] },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

SupportTicketSchema.index({ submittedBy: 1, createdAt: -1 });
SupportTicketSchema.index({ status: 1 });
SupportTicketSchema.index({ type: 1 });
SupportTicketSchema.index({ category: 1 });
SupportTicketSchema.index({ priority: 1 });
SupportTicketSchema.index({ assignedTo: 1, status: 1 });

module.exports = model('SupportTicket', SupportTicketSchema);
