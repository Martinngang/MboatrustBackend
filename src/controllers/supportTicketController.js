const { SupportTicket, User } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const notificationService = require('../services/notificationService');
const { logAdminAction } = require('../services/adminActionLogService');

const DEFAULT_PRIORITY_BY_TYPE = {
  bug_report: 'high',
  feedback: 'normal',
  question: 'normal',
  contact_support: 'normal',
};

function isAdminUser(user) {
  return Boolean(user.roles?.some((r) => r.roleType === 'admin'));
}

const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, status, type, category, search, priority, assignedTo } = req.query;
  const filter = {};
  const admin = isAdminUser(req.user);

  if (!admin) {
    filter.submittedBy = req.user._id;
  }
  if (status) filter.status = status;
  if (type) filter.type = type;
  if (category) filter.category = category;
  // Triage filters are admin-only: priority is an admin-owned field, and a
  // submitter filtering by assignee would just be filtering their own
  // tickets by which admin happens to hold them.
  if (admin && priority) filter.priority = priority;
  if (admin && assignedTo) {
    // 'unassigned' is the queue that matters most on a shared rota; 'me' saves
    // the client from having to know its own admin id.
    if (assignedTo === 'unassigned') filter.assignedTo = null;
    else if (assignedTo === 'me') filter.assignedTo = req.user._id;
    else filter.assignedTo = assignedTo;
  }
  // Ticket volume is small enough that a regex scan is fine here — unlike
  // HelpArticle's `$text` search, this doesn't need a text index.
  if (admin && search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ subject: re }, { description: re }];
  }

  const [items, total] = await Promise.all([
    SupportTicket.find(filter)
      .populate('submittedBy', 'fullName email')
      .populate('assignedTo', 'fullName email')
      .populate('responses.authorId', 'fullName')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    SupportTicket.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getOne = catchAsync(async (req, res) => {
  const ticket = await SupportTicket.findById(req.params.id)
    .populate('submittedBy', 'fullName email')
    .populate('assignedTo', 'fullName email')
    .populate('responses.authorId', 'fullName');
  if (!ticket) throw ApiError.notFound('Support ticket not found');

  const admin = isAdminUser(req.user);
  const isOwner = String(ticket.submittedBy?._id ?? ticket.submittedBy) === String(req.user._id);
  if (!admin && !isOwner) throw ApiError.forbidden('Not authorized to view this ticket');

  return ok(res, ticket);
});

const create = catchAsync(async (req, res) => {
  const priority = DEFAULT_PRIORITY_BY_TYPE[req.body.type] || 'normal';
  const ticket = await SupportTicket.create({
    ...req.body,
    submittedBy: req.user._id,
    priority,
  });
  return created(res, ticket);
});

/**
 * Shared by the submitter (following up) and an admin (responding) — the
 * status-transition rules below are what actually distinguish the two, not
 * separate endpoints: an admin reply on an `open` ticket auto-advances it
 * to `in_progress`; the owner's own follow-up on a `resolved`/`closed`
 * ticket auto-reopens it, since a reply there means "this isn't over".
 * Moving to `resolved`/`closed` is always a distinct, explicit admin action
 * (see `updateStatus`) — never implied by a reply either way.
 */
const addResponse = catchAsync(async (req, res) => {
  const ticket = await SupportTicket.findById(req.params.id);
  if (!ticket) throw ApiError.notFound('Support ticket not found');

  const admin = isAdminUser(req.user);
  const isOwner = String(ticket.submittedBy) === String(req.user._id);
  if (!admin && !isOwner) throw ApiError.forbidden('Not authorized to respond to this ticket');

  ticket.responses.push({ authorId: req.user._id, isAdmin: admin, message: req.body.message });

  if (admin && ticket.status === 'open') {
    ticket.status = 'in_progress';
  } else if (!admin && (ticket.status === 'resolved' || ticket.status === 'closed')) {
    ticket.status = 'in_progress';
  }

  await ticket.save();

  if (admin && !isOwner) {
    await notificationService.notify(ticket.submittedBy, 'support_ticket_response', {
      ticketId: ticket._id,
      subject: ticket.subject,
    });
    await logAdminAction({
      adminId: req.user._id,
      action: 'support_ticket.respond',
      targetType: 'SupportTicket',
      targetId: ticket._id,
      detail: { status: ticket.status },
    });
  }

  return ok(res, ticket);
});

/** Admin-only, explicit status/priority control — never implied by a reply. */
const updateStatus = catchAsync(async (req, res) => {
  const ticket = await SupportTicket.findById(req.params.id);
  if (!ticket) throw ApiError.notFound('Support ticket not found');

  ticket.status = req.body.status;
  if (req.body.priority) ticket.priority = req.body.priority;
  if (ticket.status === 'resolved' && !ticket.resolvedAt) {
    ticket.resolvedAt = new Date();
  } else if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
    ticket.resolvedAt = null;
  }
  await ticket.save();

  await notificationService.notify(ticket.submittedBy, 'support_ticket_status_changed', {
    ticketId: ticket._id,
    subject: ticket.subject,
    status: ticket.status,
  });
  await logAdminAction({
    adminId: req.user._id,
    action: 'support_ticket.update_status',
    targetType: 'SupportTicket',
    targetId: ticket._id,
    detail: { status: ticket.status, priority: ticket.priority },
  });

  return ok(res, ticket);
});

/**
 * Admin-only triage ownership. `assignedTo: null` deliberately returns the
 * ticket to the unassigned queue rather than being rejected — handing a
 * ticket back is as real an action as claiming one. Assignment is kept
 * separate from `updateStatus` because claiming a ticket and resolving it
 * are different decisions that shouldn't have to happen in one request.
 */
const assign = catchAsync(async (req, res) => {
  const ticket = await SupportTicket.findById(req.params.id);
  if (!ticket) throw ApiError.notFound('Support ticket not found');

  const assigneeId = req.body.assignedTo ?? null;
  if (assigneeId) {
    const assignee = await User.findById(assigneeId).select('roles fullName');
    if (!assignee) throw ApiError.badRequest('Assignee not found');
    if (!isAdminUser(assignee)) throw ApiError.badRequest('Tickets can only be assigned to an admin');
  }

  ticket.assignedTo = assigneeId;
  // Claiming an untouched ticket is itself the start of work — otherwise the
  // board shows owned tickets still sitting in `open`, which is the same
  // "is anyone on this?" ambiguity assignment exists to remove.
  if (assigneeId && ticket.status === 'open') ticket.status = 'in_progress';
  await ticket.save();

  await logAdminAction({
    adminId: req.user._id,
    action: assigneeId ? 'support_ticket.assign' : 'support_ticket.unassign',
    targetType: 'SupportTicket',
    targetId: ticket._id,
    detail: { assignedTo: assigneeId, status: ticket.status },
  });

  const populated = await ticket.populate([
    { path: 'submittedBy', select: 'fullName email' },
    { path: 'assignedTo', select: 'fullName email' },
    { path: 'responses.authorId', select: 'fullName' },
  ]);
  return ok(res, populated);
});

module.exports = { getAll, getOne, create, addResponse, updateStatus, assign };
