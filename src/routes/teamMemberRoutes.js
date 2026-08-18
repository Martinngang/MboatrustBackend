const { Router } = require('express');
const controller = require('../controllers/teamMemberController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { invite, updateRole } = require('../validators/teamMemberValidators');

const router = Router();

router.get('/mine', authenticate, controller.getMine);
router.post('/', authenticate, validate(invite), controller.invite);
router.post('/claim', authenticate, controller.claim);
router.patch('/:id/role', authenticate, validate(updateRole), controller.updateRole);
router.delete('/:id', authenticate, controller.remove);

module.exports = router;
