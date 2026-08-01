const { Router } = require('express');
const landListingController = require('../controllers/landListingController');
const { authenticate, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const upload = require('../middleware/upload');
const idempotent = require('../middleware/idempotency');
const {
  createLandListing,
  updateLandListing,
  updateVerificationStatus,
  purchaseListing,
} = require('../validators/landValidators');

const router = Router();

router.get('/', landListingController.getAll);
router.get('/:id', landListingController.getOne);
router.post(
  '/',
  authenticate,
  requireRole('land_seller'),
  validate(createLandListing),
  landListingController.create
);
router.patch('/:id', authenticate, validate(updateLandListing), landListingController.update);
router.delete('/:id', authenticate, landListingController.remove);

router.post('/:id/documents', authenticate, upload.single('file'), landListingController.addDocument);
router.post('/:id/purchase', authenticate, idempotent, validate(purchaseListing), landListingController.purchase);
router.patch(
  '/:id/verification-status',
  authenticate,
  requireRole('admin', 'verifier'),
  validate(updateVerificationStatus),
  landListingController.updateVerificationStatus
);

module.exports = router;
