const { Schema, model } = require('mongoose');

/** A funder/diaspora-account's shared-access roster — who can fund, approve
 * milestones, or just view. Single-account-owned analog of Group/GroupMember
 * (no parent "Team" document, ownerId lives directly on each row) since this
 * codebase has no Organization/Account concept to hang a team off of.
 * userId stays null until the invited email matches (or later signs up as) a
 * real account — see teamMemberController.invite/claim. */
const TeamMemberSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    invitedEmail: { type: String, required: true, lowercase: true, trim: true },
    invitedName: { type: String, default: '' },
    role: { type: String, enum: ['owner', 'approver', 'viewer'], default: 'viewer' },
    status: { type: String, enum: ['invited', 'active'], default: 'invited' },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

TeamMemberSchema.index({ ownerId: 1 });
// Can't double-invite the same email into the same owner's roster.
TeamMemberSchema.index({ ownerId: 1, invitedEmail: 1 }, { unique: true });

module.exports = model('TeamMember', TeamMemberSchema);
