const storageService = require('./storageService');

/**
 * Builds and uploads the "digital contract" document for an accepted bid.
 * Plain formatted text, not an actual PDF — no PDF-rendering library exists
 * in this project (checked package.json) and adding one just for this would
 * be a heavy new dependency for a document that's really just structured
 * text; uploading it as a real, fetchable file is what actually matters for
 * generatedDocumentUrl to stop being permanently null.
 */
async function generateAndUploadContract({ project, bid, contractorName, ownerName }) {
  const milestoneLines = project.milestones
    .map((m, i) => `  ${i + 1}. ${m.name} — ${m.amount} ${project.currency} (released on approved evidence)`)
    .join('\n');
  const text =
    `MBOA TRUST — DIGITAL CONTRACT\n\n` +
    `Project: ${project.title}\n` +
    `Project owner: ${ownerName || project.ownerId}\n` +
    `Contractor: ${contractorName || bid.contractorId}\n` +
    `Total value: ${bid.price} ${project.currency}\n` +
    `Proposed timeline: ${bid.timelineDays} days\n\n` +
    `Payment milestones (released individually from escrow on verified proof):\n${milestoneLines}\n\n` +
    (project.fundingMode === 'full_upfront'
      ? `Funding terms: FULL UPFRONT — the entire contract value (${bid.price} ${project.currency}) must be held in escrow before any milestone starts.\n`
      : `Funding terms: STAGED — escrow is funded milestone by milestone. A milestone may only start once its amount is held in escrow (the funder tops up before each next milestone). ` +
        `The contractor may voluntarily proceed on an unfunded milestone at their own financial risk; doing so does not fund the milestone, release money, or guarantee payment.\n`) +
    `Total contract value, funded amount, released amount and unfunded amount are tracked separately on the platform.\n\n` +
    `Platform fee applies per milestone release per the current fee schedule.\n` +
    `Generated ${new Date().toISOString()}`;

  const buffer = Buffer.from(text, 'utf8');
  const result = await storageService.uploadBuffer(buffer, {
    folder: `mboatrust/contracts/${project._id}`,
    resourceType: 'raw',
  });

  return { text, url: result.secure_url };
}

module.exports = { generateAndUploadContract };
