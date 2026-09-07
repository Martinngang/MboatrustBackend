const { Router } = require('express');
const helpArticleController = require('../controllers/helpArticleController');
const { authenticate, requireRole, requireAdminPermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createHelpArticle, updateHelpArticle } = require('../validators/helpArticleValidators');

const router = Router();

router.get('/', authenticate, helpArticleController.getAll);
router.get('/:id', authenticate, helpArticleController.getOne);
router.post(
  '/',
  authenticate,
  requireRole('admin'),
  requireAdminPermission('support'),
  validate(createHelpArticle),
  helpArticleController.create
);
router.patch(
  '/:id',
  authenticate,
  requireRole('admin'),
  requireAdminPermission('support'),
  validate(updateHelpArticle),
  helpArticleController.update
);
router.delete(
  '/:id',
  authenticate,
  requireRole('admin'),
  requireAdminPermission('support'),
  helpArticleController.remove
);

module.exports = router;
