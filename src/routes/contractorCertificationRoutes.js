const { Router } = require('express');
const { z } = require('zod');
const controller = require('../controllers/contractorCertificationController');
const { authenticate, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');

const createCert = z.object({
  title: z.string().min(1),
  issuer: z.string().min(1),
  issuedAt: z.coerce.date().optional(),
  documentUrl: z.string().url().optional(),
});
const updateCert = createCert.partial();

const router = Router();

router.get('/', authenticate, requireRole('admin'), controller.getAll);
router.get('/me', authenticate, controller.getMine);
router.get('/:userId', authenticate, controller.getForUser);
router.post('/', authenticate, validate(createCert), controller.create);
router.patch('/:id', authenticate, validate(updateCert), controller.update);
router.delete('/:id', authenticate, controller.remove);
router.post('/:id/verify', authenticate, requireRole('admin'), controller.verify);
router.post('/:id/reject', authenticate, requireRole('admin'), controller.reject);

module.exports = router;
