const { Router } = require('express');
const { z } = require('zod');
const kycController = require('../controllers/kycController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');

const submitVerification = z.object({
  idType: z.string().min(1),
  idNumber: z.string().min(1),
  documentUrl: z.string().url().optional(),
});

const router = Router();

router.post('/verify', authenticate, validate(submitVerification), kycController.submitVerification);

module.exports = router;
