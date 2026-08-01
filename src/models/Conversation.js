const { Schema, model } = require('mongoose');

const ConversationSchema = new Schema(
  {
    contextType: { type: String, enum: ['project', 'bid', 'land_listing'], required: true },
    contextId: { type: Schema.Types.ObjectId, required: true },
    participantIds: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

ConversationSchema.index({ contextType: 1, contextId: 1 });
ConversationSchema.index({ participantIds: 1 });

module.exports = model('Conversation', ConversationSchema);
