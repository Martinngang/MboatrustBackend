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
// the category a user actually toggles.
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
  dispute_raised: 'disputes',
  dispute_resolved: 'disputes',
  // Category only matters for the *push* toggle here — email for these is
  // always sent regardless (see notificationService.CRITICAL_TYPES), since
  // they're account-status decisions, not opt-in updates. 'milestones' is
  // just the closest fit for the in-app feed's grouping/push preference.
  kyc_verified: 'milestones',
  kyc_rejected: 'milestones',
  supplier_application_approved: 'milestones',
  supplier_application_rejected: 'milestones',
  verifier_application_approved: 'milestones',
  verifier_application_rejected: 'milestones',
  milestone_payout_received: 'milestones',
  material_order_confirmed: 'milestones',
  material_order_rejected: 'milestones',
  material_order_dispatched: 'milestones',
  material_order_delivered: 'milestones',
  material_order_cancelled: 'milestones',
  // Admin dashboard actions against a user's account/data. Category here
  // again only decides the *push* toggle for the always-email ones — see
  // notificationService.CRITICAL_TYPES for exactly which of these bypass
  // the email preference entirely (every "decision" — suspend, delete,
  // role change, application/verification reject, financial reversal —
  // plus admin_permissions_changed). The remaining "routine edit" types
  // below are genuinely category-gated: an admin correcting a field is
  // lower-urgency than a status decision, so it respects the recipient's
  // normal email preference instead of always sending.
  account_deactivated: 'milestones',
  account_reactivated: 'milestones',
  account_deleted: 'milestones',
  account_updated_by_admin: 'milestones',
  password_changed_by_admin: 'milestones',
  role_granted: 'milestones',
  role_revoked: 'milestones',
  contractor_certification_verified: 'milestones',
  contractor_certification_rejected: 'milestones',
  contractor_certification_removed: 'milestones',
  contractor_certification_edited_by_admin: 'milestones',
  contractor_profile_edited_by_admin: 'milestones',
  verifier_profile_edited_by_admin: 'milestones',
  land_listing_verified: 'land',
  land_listing_verification_rejected: 'land',
  land_listing_removed: 'land',
  land_listing_edited_by_admin: 'land',
  subscription_force_cancelled: 'milestones',
  contract_terminated: 'milestones',
  contract_edited_or_removed_by_admin: 'milestones',
  escrow_refunded: 'milestones',
  escrow_removed: 'milestones',
  escrow_updated_by_admin: 'milestones',
  referral_removed: 'milestones',
  rating_removed_by_admin: 'milestones',
  rating_edited_by_admin: 'milestones',
  team_member_role_changed_by_admin: 'milestones',
  team_member_removed_by_admin: 'milestones',
  admin_permissions_changed: 'milestones',
  dispute_resolved_counterparty: 'disputes',
  support_ticket_response: 'messages',
  support_ticket_status_changed: 'messages',
};

function categoryForType(type) {
  return TYPE_TO_CATEGORY[type] || 'marketing';
}

module.exports = { CATEGORIES, DEFAULTS, defaultPrefsObject, categoryForType };
