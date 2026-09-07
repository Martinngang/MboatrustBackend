// Shared between SupportTicket and HelpArticle so a ticket's category and an
// FAQ's category always come from the same list — lets the Help Center
// surface "related articles" for a category a user is about to file a
// ticket in without a second enum to keep in sync.
const SUPPORT_CATEGORIES = [
  'payments_escrow',
  'projects_milestones',
  'bids_contracts',
  'verification_kyc',
  'land_marketplace',
  'materials_suppliers',
  'account_login',
  'messaging',
  'other',
];

module.exports = { SUPPORT_CATEGORIES };
