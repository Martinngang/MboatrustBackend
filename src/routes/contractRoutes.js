const { Router } = require('express');
const contractController = require('../controllers/contractController');
const { authenticate } = require('../middleware/auth');

const router = Router();

router.get('/', authenticate, contractController.getAll);
router.get('/:id', authenticate, contractController.getOne);
router.post('/:id/complete', authenticate, contractController.markCompleted);
router.post('/:id/terminate', authenticate, contractController.terminate);

module.exports = router;
