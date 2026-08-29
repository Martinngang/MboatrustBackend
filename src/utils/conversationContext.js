const ApiError = require('./ApiError');

function buildDirectKey(idA, idB) {
  return [String(idA), String(idB)].sort().join(':');
}

// Authorizes starting a business-context (project/bid/land_listing) conversation —
// 'direct' and 'group' are intentionally unrestricted (see NewChatModal's user search).
async function assertLegitimateContext(contextType, contextId, callerId, participantIds) {
  if (contextType === 'direct' || contextType === 'group') return;
  // Requiring these inline (rather than at module load) avoids a require cycle with models/index.js.
  const { Project, Bid, LandListing } = require('../models');
  const notFound = () => ApiError.notFound(`${contextType === 'land_listing' ? 'Listing' : contextType[0].toUpperCase() + contextType.slice(1)} not found`);
  const forbidden = () => ApiError.forbidden('Not authorized to start this conversation');

  if (contextType === 'project') {
    const project = await Project.findById(contextId).select('ownerId');
    if (!project) throw notFound();
    const ownerId = String(project.ownerId);
    if (callerId !== ownerId && !participantIds.includes(ownerId)) throw forbidden();
  } else if (contextType === 'bid') {
    const bid = await Bid.findById(contextId).select('contractorId projectId').populate('projectId', 'ownerId');
    if (!bid) throw notFound();
    const contractorId = String(bid.contractorId);
    const ownerId = String(bid.projectId.ownerId);
    const isParty = callerId === contractorId || callerId === ownerId;
    if (!isParty) throw forbidden();
    const expectedOther = callerId === contractorId ? ownerId : contractorId;
    if (!participantIds.includes(expectedOther)) throw forbidden();
  } else if (contextType === 'land_listing') {
    const listing = await LandListing.findById(contextId).select('sellerId');
    if (!listing) throw notFound();
    const sellerId = String(listing.sellerId);
    if (callerId !== sellerId && !participantIds.includes(sellerId)) throw forbidden();
  }
}

module.exports = { buildDirectKey, assertLegitimateContext };
