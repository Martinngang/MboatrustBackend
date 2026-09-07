const { Router } = require('express');
const supportTicketController = require('../controllers/supportTicketController');
const { authenticate, requireRole, requireAdminPermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const {
  createSupportTicket,
  addSupportTicketResponse,
  updateSupportTicketStatus,
  assignSupportTicket,
} = require('../validators/supportTicketValidators');

const router = Router();

router.get('/', authenticate, supportTicketController.getAll);
router.get('/:id', authenticate, supportTicketController.getOne);
router.post('/', authenticate, validate(createSupportTicket), supportTicketController.create);
router.post(
  '/:id/responses',
  authenticate,
  validate(addSupportTicketResponse),
  supportTicketController.addResponse
);
router.patch(
  '/:id/status',
  authenticate,
  requireRole('admin'),
  requireAdminPermission('support'),
  validate(updateSupportTicketStatus),
  supportTicketController.updateStatus
);
router.patch(
  '/:id/assignee',
  authenticate,
  requireRole('admin'),
  requireAdminPermission('support'),
  validate(assignSupportTicket),
  supportTicketController.assign
);

module.exports = router;
