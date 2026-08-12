const { Schema, model } = require('mongoose');

const GroupMemberSchema = new Schema(
  {
    groupId: { type: Schema.Types.ObjectId, ref: 'Group', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['owner', 'member'], default: 'member' },
    joinedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

GroupMemberSchema.index({ groupId: 1, userId: 1 }, { unique: true });

module.exports = model('GroupMember', GroupMemberSchema);
