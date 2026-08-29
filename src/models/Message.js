const { Schema, model } = require('mongoose');

const MessageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['text', 'image', 'video', 'audio', 'file'], default: 'text' },
    body: { type: String, default: '' },
    attachments: [
      {
        url: { type: String, required: true },
        type: { type: String, required: true },
        mimeType: { type: String, required: true },
        fileName: { type: String },
        sizeBytes: { type: Number },
        durationSeconds: { type: Number },
        width: { type: Number },
        height: { type: Number },
      },
    ],
    replyToId: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    reactions: [
      {
        userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        emoji: { type: String, required: true },
      },
    ],
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

MessageSchema.index({ conversationId: 1, sentAt: 1 });
MessageSchema.index({ body: 'text' });

module.exports = model('Message', MessageSchema);
