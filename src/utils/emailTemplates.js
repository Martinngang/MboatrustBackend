const { clientOrigins } = require('../config/env');

const BRAND = { forest: '#0F7A52', forestDark: '#0A5B3D', ink: '#14171B', inkMuted: '#5B6169', cream: '#FCFBF9', border: '#E7E2D9' };
const webUrl = (path = '') => `${clientOrigins[0]}${path}`;

/** One shared branded shell for every transactional email — table-based
 * layout since that's what actually renders consistently across real email
 * clients (Gmail/Outlook strip most modern CSS), not a design nicety. */
function renderEmailHtml({ heading, body, ctaLabel, ctaUrl }) {
  const cta = ctaLabel && ctaUrl
    ? `<tr><td style="padding-top:28px;">
         <a href="${ctaUrl}" style="background:${BRAND.forest};color:#ffffff;text-decoration:none;font-family:sans-serif;font-size:14px;font-weight:600;padding:12px 24px;border-radius:999px;display:inline-block;">${ctaLabel}</a>
       </td></tr>`
    : '';

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:${BRAND.cream};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.cream};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;border:1px solid ${BRAND.border};overflow:hidden;">
            <tr>
              <td style="background:${BRAND.forestDark};padding:20px 28px;">
                <span style="font-family:Georgia,serif;font-weight:700;font-size:18px;color:#ffffff;">Mboa Trust</span>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr><td style="font-family:Georgia,serif;font-size:20px;font-weight:700;color:${BRAND.ink};padding-bottom:12px;">${heading}</td></tr>
                  <tr><td style="font-family:sans-serif;font-size:14px;line-height:22px;color:${BRAND.inkMuted};">${body}</td></tr>
                  ${cta}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px;border-top:1px solid ${BRAND.border};">
                <span style="font-family:sans-serif;font-size:11px;color:${BRAND.inkMuted};">You're receiving this because of activity on your Mboa Trust account. Manage email preferences in Settings → Notifications.</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

const money = (amount, currency = 'XAF') => (amount == null ? '' : `${currency} ${Number(amount).toLocaleString()}`);

/** One entry per notify() `type` this backend actually fires (see
 * notificationCategories.js's TYPE_TO_CATEGORY for the full list) — each
 * returns the subject/heading/body/CTA for that event. Anything not listed
 * here falls back to a generic humanized message in notificationService
 * rather than silently sending nothing, so a new notify() type added later
 * degrades gracefully instead of needing this file touched in lockstep. */
const CONTENT = {
  kyc_verified: () => ({
    subject: 'Your identity has been verified',
    heading: 'Identity verified',
    body: 'Your ID verification is complete. You now have full access to escrow payments and contractor hiring on Mboa Trust.',
    ctaLabel: 'Open Mboa Trust',
    ctaUrl: webUrl('/home'),
  }),
  kyc_rejected: () => ({
    subject: 'Your identity verification needs attention',
    heading: 'Verification not approved',
    body: "We couldn't verify your identity with the document provided. Please review the details and submit again.",
    ctaLabel: 'Retry verification',
    ctaUrl: webUrl('/kyc'),
  }),
  supplier_application_approved: (p) => ({
    subject: 'Your Quincaillerie application was approved',
    heading: 'You’re approved as a supplier',
    body: `${p?.businessName ? `"${p.businessName}" is` : 'Your store is'} now live. You can start receiving material orders from funded projects.`,
    ctaLabel: 'Go to your store',
    ctaUrl: webUrl('/supplier/dashboard'),
  }),
  supplier_application_rejected: () => ({
    subject: 'Your Quincaillerie application was not approved',
    heading: 'Application not approved',
    body: 'Your supplier registration was not approved this time. You can update your details and resubmit for review.',
    ctaLabel: 'Update application',
    ctaUrl: webUrl('/supplier/register'),
  }),
  verifier_application_approved: () => ({
    subject: 'Your Verifier application was approved',
    heading: 'You’re approved as a verifier',
    body: 'You can now receive on-site verification assignments and start filing inspection reports.',
    ctaLabel: 'View your dashboard',
    ctaUrl: webUrl('/verifier/dashboard'),
  }),
  verifier_application_rejected: () => ({
    subject: 'Your Verifier application was not approved',
    heading: 'Application not approved',
    body: 'Your verifier application was not approved this time. You can update your details and resubmit for review.',
    ctaLabel: 'Update application',
    ctaUrl: webUrl('/verifier/register'),
  }),
  milestone_payout_received: (p) => ({
    subject: `Payment released: ${money(p?.amount, p?.currency)}`,
    heading: 'Funds have been released to you',
    body: `${money(p?.amount, p?.currency)} for "${p?.milestoneTitle || 'a milestone'}" has been sent to your registered payout method.`,
    ctaLabel: 'View transaction history',
    ctaUrl: webUrl('/transactions'),
  }),
  material_order_confirmed: (p) => ({
    subject: 'Your material order was confirmed',
    heading: 'Order confirmed',
    body: `The supplier confirmed your order${p?.totalAmount ? ` for ${money(p.totalAmount, p.currency)}` : ''}. You'll be notified again once it's dispatched.`,
  }),
  material_order_rejected: (p) => ({
    subject: 'Your material order was declined',
    heading: 'Order declined',
    body: `The supplier was unable to fulfill your order${p?.reason ? `: "${p.reason}"` : '.'} Try requesting from another supplier.`,
  }),
  material_order_dispatched: () => ({
    subject: 'Your material order is on its way',
    heading: 'Order out for delivery',
    body: 'Your materials have been dispatched and are on the way to the delivery address on file.',
  }),
  material_order_delivered: () => ({
    subject: 'Material order delivered',
    heading: 'Delivery confirmed',
    body: 'Delivery for your material order has been confirmed on site.',
  }),
  material_order_cancelled: () => ({
    subject: 'A material order was cancelled',
    heading: 'Order cancelled',
    body: 'A pending material order tied to your project has been cancelled.',
  }),
  bid_received: () => ({
    subject: 'You received a new bid',
    heading: 'New bid on your tender',
    body: 'A contractor just submitted a bid on one of your open tenders.',
    ctaLabel: 'Review the bid',
    ctaUrl: webUrl('/projects'),
  }),
  bid_status_changed: (p) => ({
    subject: `Your bid was ${p?.status || 'updated'}`,
    heading: `Bid ${p?.status || 'updated'}`,
    body: `The status of your bid changed to "${p?.status || 'updated'}".`,
    ctaLabel: 'View your bids',
    ctaUrl: webUrl('/contractor/bids'),
  }),
  dispute_raised: () => ({
    subject: 'A dispute was raised',
    heading: 'Dispute raised',
    body: 'A dispute has been opened on one of your project milestones and needs your attention.',
    ctaLabel: 'View dispute',
    ctaUrl: webUrl('/projects'),
  }),
  dispute_resolved: () => ({
    subject: 'A dispute was resolved',
    heading: 'Dispute resolved',
    body: 'The dispute on your project milestone has been resolved by an admin.',
    ctaLabel: 'View project',
    ctaUrl: webUrl('/projects'),
  }),
  new_message: () => ({
    subject: 'You have a new message',
    heading: 'New message',
    body: 'You have a new message waiting in Mboa Trust.',
    ctaLabel: 'Open messages',
    ctaUrl: webUrl('/messages'),
  }),
  milestone_decision: (p) => ({
    subject: `Milestone ${p?.decision || 'reviewed'}`,
    heading: `Milestone ${p?.decision || 'reviewed'}`,
    body: p?.decision === 'approved'
      ? 'Your milestone submission was approved and payment has been released.'
      : 'Your milestone submission was reviewed. Check the project for details.',
    ctaLabel: 'View project',
    ctaUrl: webUrl('/projects'),
  }),
  milestone_evidence_submitted: (p) => ({
    subject: `New evidence submitted${p?.milestoneName ? ` for "${p.milestoneName}"` : ''}`,
    heading: 'Milestone evidence submitted',
    body: p?.submittedByName
      ? `${p.submittedByName} submitted evidence on behalf of the contractor${p?.milestoneName ? ` for "${p.milestoneName}"` : ''}. Review it when ready.`
      : `New evidence was submitted${p?.milestoneName ? ` for "${p.milestoneName}"` : ''}. Review it when ready.`,
    ctaLabel: 'Review evidence',
    ctaUrl: webUrl('/projects'),
  }),
  project_funded: () => ({
    subject: 'Your project received funding',
    heading: 'Project funded',
    body: 'Your project just received a new contribution toward its funding goal.',
    ctaLabel: 'View project',
    ctaUrl: webUrl('/projects'),
  }),

  // ── Admin Dashboard actions against a user's account/data ──────────────
  account_deactivated: () => ({
    subject: 'Your Mboa Trust account has been suspended',
    heading: 'Account suspended',
    body: 'An administrator has suspended your account. If you believe this is a mistake, contact support to appeal.',
  }),
  account_reactivated: () => ({
    subject: 'Your Mboa Trust account has been restored',
    heading: 'Account restored',
    body: 'Your account has been reactivated by an administrator. You can sign in and use Mboa Trust normally again.',
    ctaLabel: 'Sign in',
    ctaUrl: webUrl('/home'),
  }),
  account_deleted: () => ({
    subject: 'Your Mboa Trust account has been deleted',
    heading: 'Account deleted',
    body: 'An administrator has permanently deleted your Mboa Trust account and its associated data.',
  }),
  account_updated_by_admin: (p) => ({
    subject: 'Your account details were updated',
    heading: 'Account updated by an administrator',
    body: `An administrator updated the following on your account: ${(p?.fields || []).join(', ') || 'profile details'}. If this wasn't expected, contact support.`,
  }),
  password_changed_by_admin: () => ({
    subject: 'Your password was changed by an administrator',
    heading: 'Password changed',
    body: "An administrator reset your account's password. If you didn't request this, contact support immediately.",
  }),
  role_granted: (p) => ({
    subject: `You've been granted the ${p?.roleType || 'a new'} role`,
    heading: 'New role granted',
    body: `An administrator granted your account the "${p?.roleType || ''}" role. It's now available from the workspace switcher.`,
    ctaLabel: 'Open Mboa Trust',
    ctaUrl: webUrl('/home'),
  }),
  role_revoked: (p) => ({
    subject: `Your ${p?.roleType || ''} role was removed`,
    heading: 'Role removed',
    body: `An administrator removed the "${p?.roleType || ''}" role from your account.`,
  }),
  contractor_certification_verified: (p) => ({
    subject: 'Your certification was verified',
    heading: 'Certification verified',
    body: `Your certification${p?.title ? ` "${p.title}"` : ''} has been verified and now shows on your public profile.`,
    ctaLabel: 'View your profile',
    ctaUrl: webUrl('/contractor/portfolio'),
  }),
  contractor_certification_rejected: (p) => ({
    subject: "Your certification wasn't verified",
    heading: 'Certification not verified',
    body: `Your certification${p?.title ? ` "${p.title}"` : ''} could not be verified. You can edit and resubmit it.`,
    ctaLabel: 'Manage certifications',
    ctaUrl: webUrl('/contractor/certs'),
  }),
  contractor_certification_removed: (p) => ({
    subject: 'A certification was removed from your profile',
    heading: 'Certification removed',
    body: `An administrator removed the certification${p?.title ? ` "${p.title}"` : ''} from your profile.`,
  }),
  contractor_certification_edited_by_admin: () => ({
    subject: 'A certification on your profile was edited',
    heading: 'Certification updated',
    body: 'An administrator edited details on one of your certifications.',
    ctaLabel: 'View your certifications',
    ctaUrl: webUrl('/contractor/certs'),
  }),
  contractor_profile_edited_by_admin: () => ({
    subject: 'Your contractor profile was updated',
    heading: 'Profile updated by an administrator',
    body: 'An administrator made changes to your contractor profile.',
    ctaLabel: 'View your profile',
    ctaUrl: webUrl('/contractor/portfolio'),
  }),
  verifier_profile_edited_by_admin: () => ({
    subject: 'Your verifier profile was updated',
    heading: 'Profile updated by an administrator',
    body: 'An administrator made changes to your verifier profile.',
    ctaLabel: 'View your profile',
    ctaUrl: webUrl('/verifier/profile'),
  }),
  land_listing_verified: (p) => ({
    subject: 'Your land listing was verified',
    heading: 'Listing verified',
    body: `Your listing${p?.title ? ` "${p.title}"` : ''} has been verified and is now visible to buyers as a verified listing.`,
    ctaLabel: 'View listing',
    ctaUrl: webUrl('/land/mine'),
  }),
  land_listing_verification_rejected: (p) => ({
    subject: "Your land listing wasn't verified",
    heading: 'Listing not verified',
    body: `Your listing${p?.title ? ` "${p.title}"` : ''} did not pass verification. Review the listing's documentation and resubmit.`,
    ctaLabel: 'Manage listings',
    ctaUrl: webUrl('/land/mine'),
  }),
  land_listing_removed: (p) => ({
    subject: 'Your land listing was removed',
    heading: 'Listing removed',
    body: `An administrator removed your listing${p?.title ? ` "${p.title}"` : ''} from Mboa Trust.`,
  }),
  land_listing_edited_by_admin: (p) => ({
    subject: 'Your land listing was edited',
    heading: 'Listing updated by an administrator',
    body: `An administrator edited your listing${p?.title ? ` "${p.title}"` : ''}.`,
    ctaLabel: 'View listing',
    ctaUrl: webUrl('/land/mine'),
  }),
  subscription_force_cancelled: () => ({
    subject: 'Your subscription has been cancelled',
    heading: 'Subscription cancelled',
    body: 'An administrator has cancelled your Mboa Trust subscription.',
    ctaLabel: 'View subscription',
    ctaUrl: webUrl('/subscription'),
  }),
  contract_terminated: (p) => ({
    subject: 'A contract has been terminated',
    heading: 'Contract terminated',
    body: `An administrator terminated the contract${p?.projectTitle ? ` for "${p.projectTitle}"` : ''}.`,
    ctaLabel: 'View project',
    ctaUrl: webUrl('/projects'),
  }),
  contract_edited_or_removed_by_admin: () => ({
    subject: 'A contract on your project was updated',
    heading: 'Contract updated by an administrator',
    body: 'An administrator made changes to a contract tied to one of your projects.',
    ctaLabel: 'View projects',
    ctaUrl: webUrl('/projects'),
  }),
  escrow_refunded: (p) => ({
    subject: `A payment was refunded: ${money(p?.amount, p?.currency)}`,
    heading: 'Payment refunded',
    body: `An administrator reversed a completed transaction${p?.projectTitle ? ` on "${p.projectTitle}"` : ''}${p?.amount ? ` for ${money(p.amount, p.currency)}` : ''}.`,
    ctaLabel: 'View transaction history',
    ctaUrl: webUrl('/transactions'),
  }),
  escrow_removed: () => ({
    subject: 'A transaction record was removed',
    heading: 'Transaction removed',
    body: 'An administrator removed a financial transaction record tied to your account.',
    ctaLabel: 'View transaction history',
    ctaUrl: webUrl('/transactions'),
  }),
  escrow_updated_by_admin: () => ({
    subject: 'A transaction record was updated',
    heading: 'Transaction updated by an administrator',
    body: 'An administrator edited a financial transaction record tied to your account.',
    ctaLabel: 'View transaction history',
    ctaUrl: webUrl('/transactions'),
  }),
  referral_removed: () => ({
    subject: 'A referral was removed from your account',
    heading: 'Referral removed',
    body: 'An administrator removed one of your referrals, which may reverse any pending referral reward.',
  }),
  rating_removed_by_admin: () => ({
    subject: 'A review involving you was removed',
    heading: 'Review removed',
    body: 'An administrator removed a review connected to your account as part of content moderation.',
  }),
  rating_edited_by_admin: () => ({
    subject: 'A review about you was edited',
    heading: 'Review updated by an administrator',
    body: 'An administrator edited a review on your profile.',
  }),
  team_member_role_changed_by_admin: (p) => ({
    subject: 'Your team role was changed',
    heading: 'Team role updated',
    body: `An administrator changed your role on a team${p?.role ? ` to "${p.role}"` : ''}.`,
  }),
  team_member_removed_by_admin: () => ({
    subject: 'You were removed from a team',
    heading: 'Removed from team',
    body: 'An administrator removed you from a project team.',
  }),
  admin_permissions_changed: () => ({
    subject: 'Your admin permissions were updated',
    heading: 'Admin permissions updated',
    body: 'Another administrator updated what your admin account is permitted to do on Mboa Trust.',
  }),
  dispute_resolved_counterparty: (p) => ({
    subject: 'A dispute on your project was resolved',
    heading: 'Dispute resolved',
    body: `An administrator resolved a dispute${p?.projectTitle ? ` on "${p.projectTitle}"` : ''}.`,
    ctaLabel: 'View project',
    ctaUrl: webUrl('/projects'),
  }),
  support_ticket_response: (p) => ({
    subject: p?.subject ? `Re: ${p.subject}` : 'Someone replied to your support request',
    heading: 'Support has replied',
    body: `Our team replied to your request${p?.subject ? ` "${p.subject}"` : ''}. Open it to read the reply and continue the conversation.`,
    ctaLabel: 'Read the reply',
    ctaUrl: webUrl('/shared/support-requests'),
  }),
  support_ticket_status_changed: (p) => {
    // The status word is the entire point of this email, so it leads — a
    // generic "your ticket was updated" forces a round trip to learn the
    // one fact the notification exists to deliver.
    const STATUS_COPY = {
      open: { label: 'reopened', body: 'has been reopened and is back with our team' },
      in_progress: { label: 'in progress', body: 'is now being worked on by our team' },
      resolved: { label: 'resolved', body: 'has been marked resolved' },
      closed: { label: 'closed', body: 'has been closed' },
    };
    const s = STATUS_COPY[p?.status] || { label: 'updated', body: 'was updated' };
    return {
      subject: p?.subject ? `Your request "${p.subject}" is ${s.label}` : `Your support request is ${s.label}`,
      heading: `Request ${s.label}`,
      body: `Your support request${p?.subject ? ` "${p.subject}"` : ''} ${s.body}.${p?.status === 'resolved' ? ' If this isn’t sorted, reply on the request and it reopens automatically.' : ''}`,
      ctaLabel: 'View your request',
      ctaUrl: webUrl('/shared/support-requests'),
    };
  },
};

function contentForNotification(type, payload, user) {
  const builder = CONTENT[type];
  if (builder) return builder(payload, user);
  // Generic fallback so any notify() type not explicitly authored above
  // still sends something coherent instead of nothing.
  const label = type.replace(/_/g, ' ');
  return {
    subject: `Mboa Trust: ${label}`,
    heading: label.charAt(0).toUpperCase() + label.slice(1),
    body: 'Open Mboa Trust to see the details.',
    ctaLabel: 'Open Mboa Trust',
    ctaUrl: webUrl('/home'),
  };
}

module.exports = { renderEmailHtml, contentForNotification };
