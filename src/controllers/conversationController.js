const { Conversation, Message, ConversationParticipant, User } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { buildDirectKey, assertLegitimateContext } = require('../utils/conversationContext');
const notificationService = require('../services/notificationService');
const { getAdvisorUserId } = require('../services/bootstrapAdvisorService');

const getMine = catchAsync(async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const userId = req.user._id;
  const filter = { participantIds: userId };

  // Pinned-first, then recency. Pin state lives on the caller's own
  // ConversationParticipant row (pinnedAt) — today that's only ever set
  // automatically for the AI Advisor conversation (see getOrCreateAdvisor),
  // never a general user-togglable feature.
  const sorted = await Conversation.aggregate([
    { $match: filter },
    { $lookup: { from: 'conversationparticipants', localField: '_id', foreignField: 'conversationId', as: 'allParticipants' } },
    { $addFields: { selfParticipant: { $first: { $filter: { input: '$allParticipants', cond: { $eq: ['$$this.userId', userId] } } } } } },
    // Explicit $type check, NOT `$ne: [pinnedAt, null]`: a conversation the
    // caller has only ever *received* has no ConversationParticipant row at
    // all (rows are upserted lazily on first read/send/pin), so pinnedAt is
    // *missing* — and in aggregation expressions missing !== null, which
    // would wrongly count every such conversation as pinned.
    { $addFields: { isPinned: { $eq: [{ $type: '$selfParticipant.pinnedAt' }, 'date'] } } },
    { $sort: { isPinned: -1, updatedAt: -1 } },
    { $skip: (page - 1) * limit },
    { $limit: Number(limit) },
    { $project: { _id: 1, isPinned: 1 } },
  ]);

  const orderedIds = sorted.map((d) => d._id);
  const isPinnedMap = new Map(sorted.map((d) => [String(d._id), d.isPinned]));
  const total = await Conversation.countDocuments(filter);

  const docsById = new Map(
    (await Conversation.find({ _id: { $in: orderedIds } }).populate('participantIds', 'fullName avatarUrl isSystemAccount'))
      .map((c) => [String(c._id), c])
  );
  const items = orderedIds.map((id) => docsById.get(String(id))).filter(Boolean);

  // Batch query for unread counts and last message
  const conversationIds = items.map(c => c._id);

  const [participants, lastMessages] = await Promise.all([
    ConversationParticipant.find({ conversationId: { $in: conversationIds }, userId: req.user._id }),
    Message.aggregate([
      { $match: { conversationId: { $in: conversationIds } } },
      { $sort: { sentAt: -1 } },
      { $group: { _id: '$conversationId', lastMessage: { $first: '$$ROOT' } } }
    ])
  ]);

  const lastReadMap = new Map(participants.map(p => [String(p.conversationId), p.lastReadAt || new Date(0)]));
  const lastMsgMap = new Map(lastMessages.map(m => [String(m._id), m.lastMessage]));

  // We do a secondary batch query to count unread messages per conversation
  const unreadPromises = items.map(async (c) => {
    const lastRead = lastReadMap.get(String(c._id)) || new Date(0);
    const unreadCount = await Message.countDocuments({ conversationId: c._id, sentAt: { $gt: lastRead } });
    return { ...c.toObject(), unreadCount, lastMessage: lastMsgMap.get(String(c._id)), pinned: isPinnedMap.get(String(c._id)) || false };
  });

  const enrichedItems = await Promise.all(unreadPromises);

  return ok(res, enrichedItems, { page: Number(page), limit: Number(limit), total });
});

const getOne = catchAsync(async (req, res) => {
  const conversation = await Conversation.findById(req.params.id).populate('participantIds', 'fullName avatarUrl isSystemAccount');
  if (!conversation) throw ApiError.notFound('Conversation not found');
  if (!conversation.participantIds.some((p) => String(p._id) === String(req.user._id))) {
    throw ApiError.forbidden();
  }
  const lastMessage = await Message.findOne({ conversationId: conversation._id }).sort({ sentAt: -1 });
  return ok(res, { ...conversation.toObject(), lastMessage });
});

// Read-only lookup for the existing 1:1 conversation with another user, if any —
// used by the frontend to redirect a freshly-opened draft chat onto a real
// conversation someone already started (e.g. from another tab/screen).
const getWithUser = catchAsync(async (req, res) => {
  const otherId = req.params.userId;
  if (String(otherId) === String(req.user._id)) throw ApiError.badRequest('Cannot message yourself');

  const directKey = buildDirectKey(req.user._id, otherId);
  const conversation = await Conversation.findOne({ directKey }).populate('participantIds', 'fullName avatarUrl isSystemAccount');
  if (!conversation) throw ApiError.notFound('No conversation yet');
  return ok(res, conversation);
});

const create = catchAsync(async (req, res) => {
  const rawIds = Array.isArray(req.body.participantIds) ? req.body.participantIds : [];
  const participantIds = Array.from(new Set([...rawIds.filter(Boolean).map(String), String(req.user._id)])).sort();
  if (participantIds.length < 2) throw ApiError.badRequest('A conversation needs another real participant');

  const { contextType, contextId, title, avatarUrl } = req.body;
  await assertLegitimateContext(contextType, contextId, String(req.user._id), participantIds);

  if (contextType === 'group') {
    const conversation = await Conversation.create({
      contextType,
      title,
      avatarUrl,
      createdBy: req.user._id,
      participantIds
    });
    await ConversationParticipant.create({
      conversationId: conversation._id,
      userId: req.user._id,
      role: 'admin'
    });
    await conversation.populate('participantIds', 'fullName avatarUrl isSystemAccount');
    // Previously nobody but the creator ever learned this group existed —
    // no push, no email, no in-app notification of any kind.
    const otherParticipantIds = participantIds.filter((id) => id !== String(req.user._id));
    if (otherParticipantIds.length > 0) {
      await notificationService.notifyMany(otherParticipantIds, 'conversation_created', { conversationId: conversation._id });
    }
    return created(res, conversation);
  }

  if (participantIds.length !== 2) {
    throw ApiError.badRequest('Non-group conversations must have exactly two participants');
  }

  // One thread per pair of users, regardless of which context (project/bid/
  // land_listing/direct) it was started from — dedupe purely on the pair.
  const directKey = buildDirectKey(participantIds[0], participantIds[1]);
  const existing = await Conversation.findOne({ directKey }).populate('participantIds', 'fullName avatarUrl isSystemAccount');
  if (existing) return ok(res, existing);

  // Nothing persisted yet: opening a chat must not create a row until a message
  // is actually sent. Return an unsaved draft the frontend can render; the real
  // conversation is created atomically by POST /messages/direct on first send.
  const participants = await User.find({ _id: { $in: participantIds } }).select('fullName avatarUrl isSystemAccount');
  return ok(res, {
    _id: null,
    contextType,
    contextId: contextId || null,
    title: null,
    avatarUrl: null,
    createdBy: null,
    participantIds: participants,
    updatedAt: new Date().toISOString(),
  });
});

const adminGetAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, contextType } = req.query;
  const filter = {};
  if (contextType) filter.contextType = contextType;

  const [items, total] = await Promise.all([
    Conversation.find(filter).populate('participantIds', 'fullName avatarUrl').sort('-updatedAt').skip((page - 1) * limit).limit(Number(limit)),
    Conversation.countDocuments(filter),
  ]);
  const counts = await Message.aggregate([
    { $match: { conversationId: { $in: items.map((c) => c._id) } } },
    { $group: { _id: '$conversationId', count: { $sum: 1 } } },
  ]);
  const countByConversation = new Map(counts.map((c) => [String(c._id), c.count]));
  const withCounts = items.map((c) => ({ ...c.toObject(), messageCount: countByConversation.get(String(c._id)) || 0 }));
  return ok(res, withCounts, { page: Number(page), limit: Number(limit), total });
});

const markRead = catchAsync(async (req, res) => {
  const { id } = req.params;
  await ConversationParticipant.updateOne(
    { conversationId: id, userId: req.user._id },
    { $set: { lastReadAt: new Date() } },
    { upsert: true }
  );
  return ok(res, { success: true });
});

// Get-or-create the caller's 1:1 conversation with the Mboa Trust Advisor,
// pin it, and — only the very first time it's opened (no messages yet) —
// seed a real, persisted greeting so it's never an empty shell the moment
// someone lands on it. This is what both frontends' "Message" button on the
// Dedicated Advisor card calls instead of the generic draft-until-first-send
// flow, which has no way to persist/pin a conversation before a human sends
// the first message.
const getOrCreateAdvisor = catchAsync(async (req, res) => {
  const advisorId = getAdvisorUserId();
  const participantIds = [String(req.user._id), String(advisorId)].sort();
  const directKey = buildDirectKey(req.user._id, advisorId);

  let conversation;
  try {
    conversation = await Conversation.findOneAndUpdate(
      { directKey },
      { $setOnInsert: { directKey, contextType: 'direct', contextId: null, createdBy: req.user._id, participantIds } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    if (err.code === 11000) conversation = await Conversation.findOne({ directKey });
    else throw err;
  }

  // Always (re-)pinned, server-side and automatic — not a general
  // user-togglable pin feature. Self-healing if ever manually unpinned.
  await ConversationParticipant.updateOne(
    { conversationId: conversation._id, userId: req.user._id },
    { $set: { pinnedAt: new Date() }, $setOnInsert: { conversationId: conversation._id, userId: req.user._id } },
    { upsert: true }
  );

  const io = req.app.get('io');
  const messageCount = await Message.countDocuments({ conversationId: conversation._id });
  if (messageCount === 0) {
    await require('../services/advisorReplyService').sendGreeting(conversation, io);
  }

  await conversation.populate('participantIds', 'fullName avatarUrl isSystemAccount');
  return ok(res, { conversation, advisorUserId: String(advisorId) });
});

module.exports = { getMine, getOne, getWithUser, create, adminGetAll, markRead, getOrCreateAdvisor };
