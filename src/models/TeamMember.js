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
    // Separate from `role` (which stays funder-flavored/decorative — see
    // module comment) — this is the one field any controller actually
    // checks before letting a member act on the owner's behalf. Additive
    // and explicit: a member with no entries here can view the roster but
    // do nothing else, no matter what `role` says.
    permissions: { type: [String], enum: ['submit_milestones'], default: [] },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

TeamMemberSchema.index({ ownerId: 1 });
// Can't double-invite the same email into the same owner's roster.
TeamMemberSchema.index({ ownerId: 1, invitedEmail: 1 }, { unique: true });

module.exports = model('TeamMember', TeamMemberSchema);
