const { Schema, model } = require('mongoose');

const ConversationSchema = new Schema(
  {
    contextType: { type: String, enum: ['project', 'bid', 'land_listing', 'direct', 'group'], required: true },
    contextId: { type: Schema.Types.ObjectId, required: false },
    title: { type: String, default: null },
    avatarUrl: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    participantIds: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
    // Sorted `${userIdA}:${userIdB}` pair key, set only for exactly-2-participant,
    // non-group conversations. Enforces "one thread per pair of users" at the DB
    // level regardless of which business context (project/bid/land_listing/direct)
    // the conversation started from — see utils/conversationContext.js.
    directKey: { type: String, default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

ConversationSchema.index({ contextType: 1, contextId: 1 });
ConversationSchema.index({ participantIds: 1 });
ConversationSchema.index({ directKey: 1 }, { unique: true, sparse: true });

module.exports = model('Conversation', ConversationSchema);
