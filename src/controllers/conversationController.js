const { Conversation, Message, ConversationParticipant, User } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { buildDirectKey, assertLegitimateContext } = require('../utils/conversationContext');

const getMine = catchAsync(async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const filter = { participantIds: req.user._id };

  const [items, total] = await Promise.all([
    Conversation.find(filter)
      .populate('participantIds', 'fullName avatarUrl')
      .sort('-updatedAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    Conversation.countDocuments(filter),
  ]);

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
    return { ...c.toObject(), unreadCount, lastMessage: lastMsgMap.get(String(c._id)) };
  });

  const enrichedItems = await Promise.all(unreadPromises);

  return ok(res, enrichedItems, { page: Number(page), limit: Number(limit), total });
});

const getOne = catchAsync(async (req, res) => {
  const conversation = await Conversation.findById(req.params.id).populate('participantIds', 'fullName avatarUrl');
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
  const conversation = await Conversation.findOne({ directKey }).populate('participantIds', 'fullName avatarUrl');
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
    await conversation.populate('participantIds', 'fullName avatarUrl');
    return created(res, conversation);
  }

  if (participantIds.length !== 2) {
    throw ApiError.badRequest('Non-group conversations must have exactly two participants');
  }

  // One thread per pair of users, regardless of which context (project/bid/
  // land_listing/direct) it was started from — dedupe purely on the pair.
  const directKey = buildDirectKey(participantIds[0], participantIds[1]);
  const existing = await Conversation.findOne({ directKey }).populate('participantIds', 'fullName avatarUrl');
  if (existing) return ok(res, existing);

  // Nothing persisted yet: opening a chat must not create a row until a message
  // is actually sent. Return an unsaved draft the frontend can render; the real
  // conversation is created atomically by POST /messages/direct on first send.
  const participants = await User.find({ _id: { $in: participantIds } }).select('fullName avatarUrl');
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

module.exports = { getMine, getOne, getWithUser, create, adminGetAll, markRead };
