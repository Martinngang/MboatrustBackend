const { Schema, model } = require('mongoose');

/** Everything about a conversation that's per-participant rather than
 * per-conversation — the same split this codebase already uses for
 * Group/GroupMember. `Conversation.participantIds` stays the cheap,
 * already-indexed "who's in this" membership list; this collection carries
 * the real, persisted state the old frontend used to fake in local-only
 * React state: mute/pin/archive, plus the read-receipt cursor
 * (`lastReadAt`) — one timestamp per participant is the same real pattern
 * WhatsApp/Slack use, and far cheaper than a per-message readBy array. A
 * participant added before this collection existed (or before they ever
 * muted/pinned/read anything) simply has no row yet — every read site
 * treats a missing row as "never read, not muted, not pinned, not
 * archived," and upserts lazily on first real action rather than requiring
 * a migration pass. */
const ConversationParticipantSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Admin-only meaningful for a 'group' conversation — every direct/
    // business-context conversation's participants are all 'member'.
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    lastReadAt: { type: Date, default: null },
    mutedUntil: { type: Date, default: null },
    pinnedAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
    joinedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

ConversationParticipantSchema.index({ conversationId: 1, userId: 1 }, { unique: true });
ConversationParticipantSchema.index({ userId: 1 });

module.exports = model('ConversationParticipant', ConversationParticipantSchema);
