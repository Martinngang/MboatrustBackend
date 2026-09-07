const { z } = require('zod');
const { SUPPORT_CATEGORIES } = require('../utils/supportCategories');

const createHelpArticle = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  category: z.enum(SUPPORT_CATEGORIES).optional().default('other'),
  tags: z.array(z.string()).optional().default([]),
  isPublished: z.boolean().optional().default(true),
});

const updateHelpArticle = z.object({
  question: z.string().min(1).optional(),
  answer: z.string().min(1).optional(),
  category: z.enum(SUPPORT_CATEGORIES).optional(),
  tags: z.array(z.string()).optional(),
  isPublished: z.boolean().optional(),
});

module.exports = { createHelpArticle, updateHelpArticle };
