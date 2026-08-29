const { Router } = require('express');
const contractorProfileController = require('../controllers/contractorProfileController');
const { authenticate, requireRole, requireAdminPermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const upload = require('../middleware/upload');
const { upsertMine, setAvailability } = require('../validators/contractorProfileValidators');

const router = Router();

router.get('/', contractorProfileController.getAll);
// Public leaderboard — no auth, "visible to all users" per the product ask,
// same as the directory above. Must be registered before GET /:userId below
// (a single-segment path), or Express would match the literal string
// "leaderboard" as :userId and this route would never be reached.
router.get('/leaderboard', contractorProfileController.getLeaderboard);
router.get('/me', authenticate, contractorProfileController.getMine);
router.put('/me', authenticate, upload.array('images', 8), validate(upsertMine), contractorProfileController.upsertMine);
router.get('/me/earnings', authenticate, contractorProfileController.getEarnings);
router.put('/me/availability', authenticate, validate(setAvailability), contractorProfileController.setAvailability);
router.put('/:userId', authenticate, requireRole('admin'), requireAdminPermission('contractors'), validate(upsertMine), contractorProfileController.adminUpsert);
router.get('/:userId', authenticate, contractorProfileController.getPublic);
router.get('/:userId/completed-work', authenticate, contractorProfileController.getCompletedWork);

module.exports = router;
