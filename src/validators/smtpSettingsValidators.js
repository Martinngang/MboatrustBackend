const { z } = require('zod');

const updateSmtpSettings = z.object({
  host: z.string().trim().min(1, 'Host is required'),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().trim().min(1, 'Username is required'),
  // Optional — omitted or blank means "keep the currently stored password."
  password: z.string().optional(),
  fromEmail: z.string().trim().email('Must be a valid email address'),
  fromName: z.string().trim().max(80).optional().default(''),
  enabled: z.boolean(),
});

// Every field here is optional and overrides the corresponding saved value
// only when present — see smtpSettingsService.getConfigForTest. `to` is the
// one required field: where the test message actually gets sent.
const sendTestEmail = z.object({
  to: z.string().trim().email('Provide a valid address to send the test to'),
  host: z.string().trim().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  username: z.string().trim().min(1).optional(),
  password: z.string().optional(),
  fromEmail: z.string().trim().email().optional(),
  fromName: z.string().trim().max(80).optional(),
});

module.exports = { updateSmtpSettings, sendTestEmail };
