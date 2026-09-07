const { Schema, model } = require('mongoose');
const { SUPPORT_CATEGORIES } = require('../utils/supportCategories');

const HelpArticleSchema = new Schema(
  {
    question: { type: String, required: true, trim: true },
    answer: { type: String, required: true },
    category: { type: String, enum: SUPPORT_CATEGORIES, default: 'other' },
    tags: { type: [String], default: [] },
    isPublished: { type: Boolean, default: true },
  },
  { timestamps: true }
);

HelpArticleSchema.index({ question: 'text', answer: 'text', tags: 'text' });
HelpArticleSchema.index({ category: 1, isPublished: 1 });

module.exports = model('HelpArticle', HelpArticleSchema);
