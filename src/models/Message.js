const { Schema, model } = require('mongoose');

const MessageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, default: '' },
    attachmentUrl: { type: String, default: null },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

MessageSchema.index({ conversationId: 1, sentAt: 1 });

module.exports = model('Message', MessageSchema);
