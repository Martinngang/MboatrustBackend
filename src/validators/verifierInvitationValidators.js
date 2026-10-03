const { z } = require('zod');

const inviteVerifier = z.object({
  email: z.string().email(),
  name: z.string().optional().default(''),
});

module.exports = { inviteVerifier };
