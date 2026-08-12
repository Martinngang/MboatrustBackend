const { Router } = require('express');
const riskFlagController = require('../controllers/riskFlagController');
const { authenticate, requireRole } = require('../middleware/auth');

const router = Router();

router.use(authenticate, requireRole('admin'));
router.get('/', riskFlagController.getAll);
router.get('/summary', riskFlagController.getSummary);
router.get('/:id', riskFlagController.getOne);
router.post('/', riskFlagController.create);

module.exports = router;
