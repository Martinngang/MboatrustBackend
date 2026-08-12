// Same six categories the frontend's NotificationPreferencesScreen already
// defines (MboaTrustFrontend/src/screens/NotificationPreferencesScreen.tsx
// ROWS) — kept in sync deliberately so this is actually usable by that
// screen once it's wired to the backend instead of localStorage.
const CATEGORIES = ['milestones', 'bids', 'disputes', 'messages', 'land', 'marketing'];

const DEFAULTS = {
  milestones: { push: true, email: true },
  bids: { push: true, email: false },
  disputes: { push: true, email: true },
  messages: { push: true, email: false },
  land: { push: true, email: false },
  marketing: { push: false, email: false },
};

function defaultPrefsObject() {
  return { ...DEFAULTS };
}

// Every notificationService.notify() call site's `type` string, mapped to
// the category a user actually toggles. 'disputes' has no mapped type yet —
// disputeController.js doesn't call notify() at all today, a separate,
// pre-existing gap outside this prompt's scope — the category still exists
// here so preferences for it are storable/settable in advance.
const TYPE_TO_CATEGORY = {
  bid_received: 'bids',
  bid_status_changed: 'bids',
  co_signer_added: 'milestones',
  milestone_decision: 'milestones',
  milestone_evidence_submitted: 'milestones',
  project_funded: 'milestones',
  pooled_contribution_collected: 'milestones',
  pooled_contribution_invited: 'milestones',
  verification_assigned: 'milestones',
  video_verification_requested: 'milestones',
  video_verification_scheduled: 'milestones',
  new_message: 'messages',
  land_offer_countered: 'land',
  land_offer_declined: 'land',
  land_offer_received: 'land',
  land_purchase_started: 'land',
  visit_confirmed: 'land',
  visit_requested: 'land',
};

function categoryForType(type) {
  return TYPE_TO_CATEGORY[type] || 'marketing';
}

module.exports = { CATEGORIES, DEFAULTS, defaultPrefsObject, categoryForType };
