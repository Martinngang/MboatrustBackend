const { User } = require('../models');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const kycService = require('../services/kycService');

const submitVerification = catchAsync(async (req, res) => {
  const { idType, idNumber, documentUrl } = req.body;
  const user = await User.findById(req.user._id);
  user.kycStatus = 'pending';
  await user.save();

  const result = await kycService.verifyIdentity({
    userId: String(user._id),
    idType,
    idNumber,
    documentUrl,
  });

  user.kycStatus = result.verified ? 'verified' : 'rejected';
  await user.save();

  return ok(res, { user, kycResult: result });
});

module.exports = { submitVerification };
