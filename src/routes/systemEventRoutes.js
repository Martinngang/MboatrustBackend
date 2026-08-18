const { Router } = require('express');
const systemEventController = require('../controllers/systemEventController');
const validate = require('../middleware/validate');
const { createSystemEvent } = require('../validators/systemEventValidators');

const router = Router();

// No `authenticate` — see systemEventController.create's comment. Protected
// only by the app-wide rate limiter, same as every other public route.
router.post('/', validate(createSystemEvent), systemEventController.create);

module.exports = router;
