const { Router } = require('express');
const contractorProfileController = require('../controllers/contractorProfileController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { upsertMine, setAvailability } = require('../validators/contractorProfileValidators');

const router = Router();

router.get('/', contractorProfileController.getAll);
router.get('/me', authenticate, contractorProfileController.getMine);
router.put('/me', authenticate, validate(upsertMine), contractorProfileController.upsertMine);
router.get('/me/earnings', authenticate, contractorProfileController.getEarnings);
router.put('/me/availability', authenticate, validate(setAvailability), contractorProfileController.setAvailability);
router.get('/:userId', authenticate, contractorProfileController.getPublic);

module.exports = router;
