const mongoose = require('mongoose');
const { Bid, Rating } = require('../models');

/** Live stats — never denormalized onto ContractorProfile, always computed
 * fresh from Bid/Project/Rating so they can't drift out of sync. Every
 * ratio is guarded against a zero denominator (returns 0, never NaN/Infinity).
 *
 * Lives in its own module (not contractorProfileController, where this used
 * to be defined) so contractorMatchingService and contractorLeaderboardService
 * can both import it without either one requiring a controller — importing
 * a controller from a service works one-way, but contractorLeaderboardService
 * also needs to be required *by* contractorProfileController (for the
 * leaderboard route), which would otherwise create a require cycle. */
async function getStats(userId) {
  const contractorId = new mongoose.Types.ObjectId(userId);

  const [bidCounts, completionAgg, ratingAgg] = await Promise.all([
    Bid.aggregate([
      { $match: { contractorId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Bid.aggregate([
      { $match: { contractorId, status: 'accepted' } },
      {
        $lookup: {
          from: 'projects',
          localField: 'projectId',
          foreignField: '_id',
          as: 'project',
        },
      },
      { $unwind: '$project' },
      {
        $group: {
          _id: null,
          accepted: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$project.status', 'completed'] }, 1, 0] } },
        },
      },
    ]),
    Rating.aggregate([
      { $match: { toUserId: contractorId, roleContext: 'contractor' } },
      { $group: { _id: null, average: { $avg: '$score' }, count: { $sum: 1 } } },
    ]),
  ]);

  const totalBids = bidCounts.reduce((sum, b) => sum + b.count, 0);
  const acceptedBids = bidCounts.find((b) => b._id === 'accepted')?.count || 0;
  const completedProjects = completionAgg[0]?.completed || 0;
  const completionRate = acceptedBids > 0 ? completedProjects / acceptedBids : 0;
  const avgRating = ratingAgg[0]?.average ?? null;
  const ratingCount = ratingAgg[0]?.count || 0;

  return { completedProjects, totalBids, acceptedBids, completionRate, avgRating, ratingCount };
}

module.exports = { getStats };
