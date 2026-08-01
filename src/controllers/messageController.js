const { Conversation, Message } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const notificationService = require('../services/notificationService');

async function assertParticipant(conversationId, userId) {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw ApiError.notFound('Conversation not found');
  if (!conversation.participantIds.some((p) => String(p) === String(userId))) {
    throw ApiError.forbidden();
  }
  return conversation;
}

const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const { conversationId } = req.params;
  await assertParticipant(conversationId, req.user._id);

  const [items, total] = await Promise.all([
    Message.find({ conversationId })
      .populate('senderId', 'fullName')
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

  let message = await Message.create({
    conversationId,
    senderId: req.user._id,
    body: req.body.body,
    attachmentUrl: req.body.attachmentUrl,
  });
  message = await message.populate('senderId', 'fullName');

  conversation.updatedAt = new Date();
  await conversation.save();

  const io = req.app.get('io');
  if (io) io.to(`conversation:${conversationId}`).emit('message:new', message);

  const recipients = conversation.participantIds.filter((p) => String(p) !== String(req.user._id));
  await notificationService.notifyMany(recipients, 'new_message', {
    conversationId,
    messageId: message._id,
  });

  return created(res, message);
});

module.exports = { getAll, create };
