const { User } = require('../models');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const kycService = require('../services/kycService');

const submitVerification = catchAsync(async (req, res) => {
  const { idType, idNumber, country, documentUrl } = req.body;
  const user = await User.findById(req.user._id);
  const previousStatus = user.kycStatus;
  user.kycStatus = 'pending';
  await user.save();

  let result;
  try {
    result = await kycService.verifyIdentity({
      userId: String(user._id),
      idType,
      idNumber,
      ...(country ? { country } : {}),
      documentUrl,
    });
  } catch (err) {
    // Don't leave the account stuck in 'pending' if the verification
    // provider call itself fails (network error, provider outage, bad
    // request) — revert to whatever status was true before this attempt
    // so the user can see the real state and retry.
    user.kycStatus = previousStatus;
    await user.save();
    throw err;
  }

  user.kycStatus = result.verified ? 'verified' : 'rejected';
  await user.save();

  return ok(res, { user, kycResult: result });
});

module.exports = { submitVerification };
