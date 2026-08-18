const { TeamMember, User } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

/** Every roster row is implicitly scoped to req.user._id as the owner —
 * there's no route param for "whose team," so a caller can only ever
 * manage their own roster through these self-service endpoints. Only
 * updateRole/remove need an explicit ownership check, since those target a
 * specific row by id that isn't inherently proven to belong to the caller. */
const getMine = catchAsync(async (req, res) => {
  const hasOwnerRow = await TeamMember.exists({ ownerId: req.user._id, userId: req.user._id });
  if (!hasOwnerRow) {
    await TeamMember.create({
      ownerId: req.user._id,
      userId: req.user._id,
      invitedEmail: req.user.email || '',
      invitedName: req.user.fullName,
      role: 'owner',
      status: 'active',
    });
  }
  const members = await TeamMember.find({ ownerId: req.user._id }).populate('userId', 'fullName avatarUrl').sort('createdAt');
  return ok(res, members);
});

/** Straight add when the invited email already belongs to a real account
 * (same "no separate invite-token flow" convention as groupController.invite)
 * — otherwise the row waits in 'invited' status until that person signs up
 * and calls claim. */
const invite = catchAsync(async (req, res) => {
  const { email, name, role } = req.body;
  const existing = await TeamMember.findOne({ ownerId: req.user._id, invitedEmail: email.toLowerCase() });
  if (existing) throw ApiError.conflict('Already invited');

  const matchedUser = await User.findOne({ email: email.toLowerCase() });
  const member = await TeamMember.create({
    ownerId: req.user._id,
    userId: matchedUser ? matchedUser._id : null,
    invitedEmail: email.toLowerCase(),
    invitedName: name || matchedUser?.fullName || '',
    role,
    status: matchedUser ? 'active' : 'invited',
  });
  return created(res, member);
});

/** Best-effort, called after login the same way Onboarding.tsx claims a
 * pending referral — never blocks sign-in, just links any roster rows that
 * were invited by email before this account existed. */
const claim = catchAsync(async (req, res) => {
  if (!req.user.email) return ok(res, { claimed: 0 });
  const result = await TeamMember.updateMany(
    { invitedEmail: req.user.email.toLowerCase(), status: 'invited' },
    { $set: { userId: req.user._id, status: 'active' } }
  );
  return ok(res, { claimed: result.modifiedCount });
});

function assertOwnsAndNotSelf(member, req) {
  if (!member) throw ApiError.notFound('Team member not found');
  if (String(member.ownerId) !== String(req.user._id)) throw ApiError.forbidden('Only the team owner can do this');
  if (member.role === 'owner') throw ApiError.conflict("Can't modify the owner's own row");
}

const updateRole = catchAsync(async (req, res) => {
  const member = await TeamMember.findById(req.params.id);
  assertOwnsAndNotSelf(member, req);
  member.role = req.body.role;
  await member.save();
  return ok(res, member);
});

const remove = catchAsync(async (req, res) => {
  const member = await TeamMember.findById(req.params.id);
  assertOwnsAndNotSelf(member, req);
  await member.deleteOne();
  return res.status(204).send();
});

module.exports = { getMine, invite, claim, updateRole, remove };
