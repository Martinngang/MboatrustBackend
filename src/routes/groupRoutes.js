const { Router } = require('express');
const groupController = require('../controllers/groupController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createGroup, inviteMember } = require('../validators/groupValidators');

const router = Router();

router.get('/mine', authenticate, groupController.getMine);
router.get('/:id', authenticate, groupController.getOne);
router.get('/:id/dashboard', authenticate, groupController.getDashboard);
router.post('/', authenticate, validate(createGroup), groupController.create);
router.post('/:id/invite', authenticate, validate(inviteMember), groupController.invite);
router.post('/:id/join', authenticate, groupController.join);
router.post('/:id/leave', authenticate, groupController.leave);

module.exports = router;
