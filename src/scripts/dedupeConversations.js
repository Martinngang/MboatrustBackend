// One-off cleanup for data created before the 1:1 "one conversation per pair"
// invariant existed: removes conversations with zero messages, and merges
// duplicate 2-participant conversations for the same pair of users into a
// single survivor (keeping the one with the most messages, tie-broken by
// oldest createdAt), reassigning messages/read-receipts before deleting the
// losers. Finally backfills `directKey` on every surviving 2-participant,
// non-group conversation so the unique index can be created cleanly.
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { Conversation, Message, ConversationParticipant } = require('../models');
const { buildDirectKey } = require('../utils/conversationContext');

async function run() {
  await connectDB();

  console.log('[dedupe] scanning conversations…');
  const all = await Conversation.find({}).lean();
  console.log(`[dedupe] ${all.length} total conversations`);

  const messageCounts = await Message.aggregate([
    { $group: { _id: '$conversationId', count: { $sum: 1 } } },
  ]);
  const countByConversation = new Map(messageCounts.map((m) => [String(m._id), m.count]));

  // 1. Delete empty conversations (zero messages ever sent) — these are the
  //    "opened a chat, sent nothing, closed it" artifacts from the old eager-create flow.
  const emptyIds = all.filter((c) => !countByConversation.get(String(c._id))).map((c) => c._id);
  if (emptyIds.length > 0) {
    await ConversationParticipant.deleteMany({ conversationId: { $in: emptyIds } });
    await Conversation.deleteMany({ _id: { $in: emptyIds } });
    console.log(`[dedupe] removed ${emptyIds.length} empty conversation(s)`);
  }

  // 2. Merge duplicate 2-participant, non-group conversations for the same pair.
  const survivors = all.filter((c) => !emptyIds.includes(c._id) && c.contextType !== 'group' && (c.participantIds || []).length === 2);
  const byPair = new Map();
  for (const c of survivors) {
    const key = buildDirectKey(c.participantIds[0], c.participantIds[1]);
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(c);
  }

  let mergedGroups = 0;
  let mergedAway = 0;
  for (const [directKey, group] of byPair) {
    if (group.length < 2) {
      // Single conversation for this pair — just backfill directKey.
      await Conversation.updateOne({ _id: group[0]._id }, { $set: { directKey } });
      continue;
    }

    mergedGroups += 1;
    group.sort((a, b) => {
      const countDiff = (countByConversation.get(String(b._id)) || 0) - (countByConversation.get(String(a._id)) || 0);
      if (countDiff !== 0) return countDiff;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });
    const [primary, ...losers] = group;
    const loserIds = losers.map((c) => c._id);

    await Message.updateMany({ conversationId: { $in: loserIds } }, { $set: { conversationId: primary._id } });

    // Merge read-receipts, keeping the most recent lastReadAt per user.
    const loserParticipants = await ConversationParticipant.find({ conversationId: { $in: loserIds } }).lean();
    for (const p of loserParticipants) {
      await ConversationParticipant.updateOne(
        { conversationId: primary._id, userId: p.userId },
        { $max: { lastReadAt: p.lastReadAt || new Date(0) }, $setOnInsert: { conversationId: primary._id, userId: p.userId } },
        { upsert: true }
      );
    }
    await ConversationParticipant.deleteMany({ conversationId: { $in: loserIds } });
    await Conversation.deleteMany({ _id: { $in: loserIds } });
    await Conversation.updateOne({ _id: primary._id }, { $set: { directKey } });

    mergedAway += loserIds.length;
    console.log(`[dedupe] pair ${directKey}: kept ${primary._id}, merged away ${loserIds.length} duplicate(s)`);
  }

  console.log(`[dedupe] done — ${mergedGroups} pair(s) had duplicates, ${mergedAway} duplicate conversation(s) merged away`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[dedupe] failed:', err);
  process.exit(1);
});
