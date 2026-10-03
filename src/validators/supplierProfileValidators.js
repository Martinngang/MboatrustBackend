const { z } = require('zod');
const { geoPoint } = require('./common');

// See verifierProfileValidators.js's stringArray for why this accepts either
// a real array or a JSON-encoded string — kept here too even though this
// endpoint has no file upload today, so the shape stays consistent if one
// is ever added (e.g. a real verification document).
const stringArray = z.preprocess((val) => {
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}, z.array(z.string()));

const upsertMine = z.object({
  businessName: z.string().min(1),
  // Matches every other location field's shape (nullable, not required) now
  // that the model default is null rather than {0,0} — see SupplierProfile.js.
  location: geoPoint.optional(),
  address: z.string().optional(),
  region: z.string().min(1),
  registeredCategories: stringArray.optional(),
  phone: z.string().optional(),
  paymentProvider: z.enum(['mtn_momo', 'orange_money']).optional(),
  payoutPhoneNumber: z.string().optional(),
  verificationDocUploaded: z.coerce.boolean().optional(),
});

module.exports = { upsertMine };
