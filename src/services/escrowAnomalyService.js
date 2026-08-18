const { Escrow, RiskFlag } = require('../models');

const VELOCITY_WINDOW_MS = 1000 * 60 * 10; // 10 minutes
const VELOCITY_THRESHOLD = 3; // 3+ release/refund escrows on one project this fast is unusual
const MIN_AMOUNT_HISTORY = 2; // too few prior payouts on this project to trust a baseline
const AMOUNT_OUTLIER_RATIO = 3; // this payout is 3x+ the project's own typical payout
const BENEFICIARY_VELOCITY_WINDOW_MS = 1000 * 60 * 60; // 1 hour
const BENEFICIARY_VELOCITY_THRESHOLD = 3; // 3+ releases to the same person across projects this fast

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Detection-only anomaly check on an already-persisted release/refund
 * escrow — never called before the payment has gone out, never able to
 * block or reverse it. Every check here is a heuristic signal for admin
 * review, not a judgment; a project with only one milestone or a
 * first-time contractor simply won't have enough history to trigger the
 * history-dependent checks, and that's treated as "nothing to compare
 * against" rather than guessed at.
 */
async function detectAnomaly({ escrow, beneficiaryId }) {
  const reasons = [];

  // ── Velocity: too many release/refund escrows on this project too fast ──
  const recentOnProject = await Escrow.countDocuments({
    projectId: escrow.projectId,
    type: { $in: ['release', 'refund'] },
    _id: { $ne: escrow._id },
    createdAt: { $gte: new Date(Date.now() - VELOCITY_WINDOW_MS) },
  });
  if (recentOnProject + 1 >= VELOCITY_THRESHOLD) {
    reasons.push({ type: 'project_velocity', count: recentOnProject + 1, windowMinutes: VELOCITY_WINDOW_MS / 60000 });
  }

  // ── Amount outlier: this payout vs. this project's own typical payout ──
  const priorSameProject = await Escrow.find({
    projectId: escrow.projectId,
    type: escrow.type,
    status: 'completed',
    _id: { $ne: escrow._id },
  })
    .select('netAmount')
    .lean();
  if (priorSameProject.length >= MIN_AMOUNT_HISTORY) {
    const baseline = median(priorSameProject.map((e) => e.netAmount));
    if (baseline > 0 && escrow.netAmount / baseline >= AMOUNT_OUTLIER_RATIO) {
      reasons.push({ type: 'amount_outlier', netAmount: escrow.netAmount, projectBaseline: baseline, ratio: escrow.netAmount / baseline });
    }
  }

  // ── Beneficiary velocity: many releases to the same contractor, fast, across projects ──
  if (escrow.type === 'release' && escrow.contractorId) {
    const recentToBeneficiary = await Escrow.countDocuments({
      type: 'release',
      contractorId: escrow.contractorId,
      _id: { $ne: escrow._id },
      createdAt: { $gte: new Date(Date.now() - BENEFICIARY_VELOCITY_WINDOW_MS) },
    });
    if (recentToBeneficiary + 1 >= BENEFICIARY_VELOCITY_THRESHOLD) {
      reasons.push({ type: 'beneficiary_velocity', count: recentToBeneficiary + 1, windowMinutes: BENEFICIARY_VELOCITY_WINDOW_MS / 60000 });
    }
  }

  if (reasons.length === 0) return null;

  // ── Cross-signal: escalate if this beneficiary already has an open flag ──
  const existingFlag = await RiskFlag.findOne({ userId: beneficiaryId }).lean();
  const severity = existingFlag ? 'high' : 'medium';

  return { reasons, severity };
}

/** Runs detection and persists a RiskFlag if anything triggered — wrapped
 * so a failure here can never surface past this function; callers await it
 * purely for the (rare) side effect, after their own escrow/project writes
 * have already committed. `beneficiaryId` is always a real user: the
 * accepted contractor for a tender release, otherwise the project owner
 * (who is required on every Project, so this is never null). */
async function checkAndFlag({ escrow, beneficiaryId }) {
  try {
    const anomaly = await detectAnomaly({ escrow, beneficiaryId });
    if (!anomaly) return null;
    return await RiskFlag.create({
      userId: beneficiaryId,
      flagType: 'escrow_anomaly',
      severity: anomaly.severity,
      detail: { escrowId: escrow._id, projectId: escrow.projectId, escrowType: escrow.type, reasons: anomaly.reasons },
    });
  } catch (err) {
    console.error('[escrowAnomalyService] detection failed (non-blocking):', err.message);
    return null;
  }
}

module.exports = { detectAnomaly, checkAndFlag };
