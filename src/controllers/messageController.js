const { Conversation, Message, ConversationParticipant, User } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const notificationService = require('../services/notificationService');
const storageService = require('../services/storageService');
const { buildDirectKey, assertLegitimateContext } = require('../utils/conversationContext');

async function assertParticipant(conversationId, userId) {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw ApiError.notFound('Conversation not found');
  if (!conversation.participantIds.some((p) => String(p) === String(userId))) {
    throw ApiError.forbidden();
  }
  return conversation;
}

// Shared by create() and createDirect(): persists the message, touches the
// conversation, marks the sender's own read pointer, and fans out the
// realtime/notification side effects. Returns the populated message.
async function deliverMessage(conversation, sender, { body, attachments, replyToId }, io) {
  let type = 'text';
  if (attachments && attachments.length > 0) {
    type = attachments[0].type || 'file'; // rough inference
  }

  let message = await Message.create({
    conversationId: conversation._id,
    senderId: sender._id,
    type,
    body: body || '',
    attachments: attachments || [],
    replyToId: replyToId || null,
  });
  message = await message.populate('senderId', 'fullName avatarUrl');

  conversation.updatedAt = new Date();
  await conversation.save();

  await ConversationParticipant.updateOne(
    { conversationId: conversation._id, userId: sender._id },
    { $set: { lastReadAt: new Date() } },
    { upsert: true }
  );

  if (io) io.to(`conversation:${conversation._id}`).emit('message:new', message);

  const recipients = conversation.participantIds.filter((p) => String(p) !== String(sender._id));
  const preview = type === 'text' ? message.body : `New ${type} message`;
  await notificationService.notifyMany(recipients, 'new_message', {
    conversationId: conversation._id,
    messageId: message._id,
    preview,
    senderName: sender.fullName,
  });

  return message;
}

const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const { conversationId } = req.params;
  await assertParticipant(conversationId, req.user._id);

  const [items, total] = await Promise.all([
    Message.find({ conversationId })
      .populate('senderId', 'fullName avatarUrl')
      .sort('sentAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    Message.countDocuments({ conversationId }),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const create = catchAsync(async (req, res) => {
  const { conversationId } = req.params;
  const conversation = await assertParticipant(conversationId, req.user._id);

  const io = req.app.get('io');
  const message = await deliverMessage(conversation, req.user, req.body, io);

  return created(res, message);
});

// Atomically resolves (or lazily creates) the 1:1 conversation with recipientId
// and sends the first message into it. This is the only way a direct/1:1
// conversation is ever persisted — merely opening a chat never creates a row,
// only a successful send does. The unique `directKey` index guarantees at
// most one conversation per pair even under concurrent double-sends.
const createDirect = catchAsync(async (req, res) => {
  const { recipientId, contextType, contextId, body, attachments, replyToId } = req.body;
  if (!recipientId) throw ApiError.badRequest('recipientId is required');
  if (String(recipientId) === String(req.user._id)) throw ApiError.badRequest('Cannot start a conversation with yourself');

  const trimmedBody = typeof body === 'string' ? body.trim() : '';
  if (!trimmedBody && !(attachments && attachments.length > 0)) {
    throw ApiError.badRequest('Message body or attachment is required');
  }

  const recipient = await User.findById(recipientId).select('_id');
  if (!recipient) throw ApiError.notFound('Recipient not found');

  const participantIds = [String(req.user._id), String(recipientId)].sort();
  const resolvedContextType = contextType || 'direct';
  await assertLegitimateContext(resolvedContextType, contextId, String(req.user._id), participantIds);

  const directKey = buildDirectKey(req.user._id, recipientId);
  let conversation;
  try {
    conversation = await Conversation.findOneAndUpdate(
      { directKey },
      {
        $setOnInsert: {
          directKey,
          contextType: resolvedContextType,
          contextId: contextId || null,
          createdBy: req.user._id,
          participantIds,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    if (err.code === 11000) {
      // Lost a concurrent upsert race — the other request already created it.
      conversation = await Conversation.findOne({ directKey });
    } else {
      throw err;
    }
  }

  const io = req.app.get('io');
  const message = await deliverMessage(conversation, req.user, { body: trimmedBody, attachments, replyToId }, io);

  await conversation.populate('participantIds', 'fullName avatarUrl');

  return created(res, { conversation, message });
});

const edit = catchAsync(async (req, res) => {
  const { id } = req.params;
  const message = await Message.findById(id).populate('senderId', 'fullName avatarUrl');
  if (!message) throw ApiError.notFound('Message not found');
  if (String(message.senderId._id) !== String(req.user._id)) throw ApiError.forbidden();

  message.body = req.body.body;
  message.editedAt = new Date();
  await message.save();

  const io = req.app.get('io');
  if (io) io.to(`conversation:${message.conversationId}`).emit('message:edited', message);

  return ok(res, message);
});

const react = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { emoji } = req.body;
  const message = await Message.findById(id).populate('senderId', 'fullName avatarUrl');
  if (!message) throw ApiError.notFound('Message not found');
  await assertParticipant(message.conversationId, req.user._id);

  const existingIndex = message.reactions.findIndex(r => String(r.userId) === String(req.user._id) && r.emoji === emoji);
  if (existingIndex >= 0) {
    message.reactions.splice(existingIndex, 1);
  } else {
    message.reactions.push({ userId: req.user._id, emoji });
  }
  await message.save();

  const io = req.app.get('io');
  if (io) io.to(`conversation:${message.conversationId}`).emit('message:edited', message);

  return ok(res, message);
});

const remove = catchAsync(async (req, res) => {
  const { id } = req.params;
  const message = await Message.findById(id).populate('senderId', 'fullName avatarUrl');
  if (!message) throw ApiError.notFound('Message not found');
  if (String(message.senderId._id) !== String(req.user._id)) throw ApiError.forbidden();

  message.deletedAt = new Date();
  message.body = '';
  message.attachments = [];
  await message.save();

  const io = req.app.get('io');
  if (io) io.to(`conversation:${message.conversationId}`).emit('message:deleted', { messageId: message._id, conversationId: message.conversationId });

  return ok(res, { success: true });
});

const uploadAttachment = catchAsync(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Provide a file');

  let resourceType = 'auto';
  let type = 'file';
  if (req.file.mimetype.startsWith('image/')) {
    resourceType = 'image';
    type = 'image';
  } else if (req.file.mimetype.startsWith('video/')) {
    resourceType = 'video';
    type = 'video';
  } else if (req.file.mimetype.startsWith('audio/')) {
    resourceType = 'video';
    type = 'audio';
  }

  const result = await storageService.uploadBuffer(req.file.buffer, {
    folder: `mboatrust/messages/${req.user._id}`,
    resourceType,
    mimeType: req.file.mimetype,
  });

  return ok(res, {
    url: result.secure_url || result.url,
    type,
    mimeType: req.file.mimetype,
    fileName: req.file.originalname,
    sizeBytes: req.file.size,
  });
});

module.exports = { getAll, create, createDirect, edit, react, remove, uploadAttachment };
