const { VideoVerificationSession, Project, VerificationTask } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const notificationService = require('../services/notificationService');

/** Owner of the project, or a verifier currently assigned to this specific
 * milestone — the same two-party model VerificationTask already uses,
 * reused here rather than inventing a separate authorization rule. */
async function assertCanManage(project, milestoneId, user) {
  if (String(project.ownerId) === String(user._id)) return;
  const assigned = await VerificationTask.findOne({
    targetType: 'milestone',
    targetId: milestoneId,
    verifierId: user._id,
  }).lean();
  if (assigned) return;
  throw ApiError.forbidden('Only the project owner or an assigned verifier can manage this video verification');
}

const request = catchAsync(async (req, res) => {
  const { projectId, milestoneId, notes } = req.body;
  const project = await Project.findById(projectId);
  if (!project) throw ApiError.notFound('Project not found');
  const milestone = project.milestones.id(milestoneId);
  if (!milestone) throw ApiError.notFound('Milestone not found');
  if (!milestone.requiresVideo) {
    throw ApiError.conflict('This milestone is not marked as requiring video verification');
  }
  await assertCanManage(project, milestoneId, req.user);

  const session = await VideoVerificationSession.create({
    projectId,
    milestoneId,
    requestedBy: req.user._id,
    notes: notes || '',
  });
  await notificationService.notify(project.ownerId, 'video_verification_requested', {
    projectId,
    milestoneId,
    sessionId: session._id,
  });
  return created(res, session);
});

const schedule = catchAsync(async (req, res) => {
  const session = await VideoVerificationSession.findById(req.params.id);
  if (!session) throw ApiError.notFound('Video verification session not found');
  if (session.status !== 'requested') throw ApiError.conflict(`Session is already "${session.status}"`);

  const project = await Project.findById(session.projectId);
  if (!project) throw ApiError.notFound('Project not found');
  await assertCanManage(project, session.milestoneId, req.user);

  session.scheduledFor = req.body.scheduledFor;
  session.meetingUrl = req.body.meetingUrl;
  session.status = 'scheduled';
  await session.save();
  await notificationService.notify(session.requestedBy, 'video_verification_scheduled', {
    sessionId: session._id,
    scheduledFor: session.scheduledFor,
  });
  return ok(res, session);
});

const complete = catchAsync(async (req, res) => {
  const session = await VideoVerificationSession.findById(req.params.id);
  if (!session) throw ApiError.notFound('Video verification session not found');
  if (session.status !== 'scheduled') throw ApiError.conflict('Only a scheduled session can be completed');

  const project = await Project.findById(session.projectId);
  if (!project) throw ApiError.notFound('Project not found');
  await assertCanManage(project, session.milestoneId, req.user);

  session.status = 'completed';
  if (req.body.notes) session.notes = req.body.notes;
  await session.save();
  return ok(res, session);
});

const cancel = catchAsync(async (req, res) => {
  const session = await VideoVerificationSession.findById(req.params.id);
  if (!session) throw ApiError.notFound('Video verification session not found');
  if (session.status === 'completed') throw ApiError.conflict('Cannot cancel a completed session');

  const project = await Project.findById(session.projectId);
  if (!project) throw ApiError.notFound('Project not found');
  await assertCanManage(project, session.milestoneId, req.user);

  session.status = 'cancelled';
  await session.save();
  return ok(res, session);
});

const getAll = catchAsync(async (req, res) => {
  const { projectId, milestoneId, status } = req.query;
  const filter = {};
  if (projectId) filter.projectId = projectId;
  if (milestoneId) filter.milestoneId = milestoneId;
  if (status) filter.status = status;
  const items = await VideoVerificationSession.find(filter).sort('-createdAt');
  return ok(res, items);
});

module.exports = { request, schedule, complete, cancel, getAll };
