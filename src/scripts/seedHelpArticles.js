// Seeds the initial Help Center FAQ content so there's something real to
// search on day one. Idempotent — re-run any time to add newly-written
// entries; existing ones (matched by `question`) are left as any admin
// edits made afterward via the Help Articles admin CRUD, never overwritten.
const { connectDB } = require('../config/db');
const { HelpArticle } = require('../models');
const mongoose = require('mongoose');

const ARTICLES = [
  {
    question: 'How does escrow work on Mboa Trust?',
    answer:
      "When a funder backs a project, their payment is held in escrow, not paid directly to the contractor. Each milestone releases its own share of that escrow only after the contractor submits evidence (photos, a geotag, and notes) and the funder — or, for larger projects, every required co-signer — approves it. A small platform fee is deducted from each milestone release. Once a milestone is approved, the payout moves automatically to the contractor's account; from there they can withdraw it from Earnings.",
    category: 'payments_escrow',
    tags: ['escrow', 'milestone', 'payout', 'funding'],
  },
  {
    question: 'How do I submit proof that a milestone is complete?',
    answer:
      "Open the project from your Contractor dashboard and choose the pending milestone, then submit at least two site photos, a description of the work completed, and your device's GPS location (captured automatically and shown before you submit). Your submission is sent to the funder and, for larger projects, an independent field verifier for review. You'll be notified as soon as it's approved and the milestone's funds are released.",
    category: 'projects_milestones',
    tags: ['milestone', 'evidence', 'photos', 'geotag', 'contractor'],
  },
  {
    question: 'What are the KYC verification levels and why do I need one?',
    answer:
      "KYC (identity verification) protects everyone moving money on the platform. Your account starts as Unverified; submitting your ID moves it to Pending while it's reviewed, then to Verified or Rejected (with a reason, and you can resubmit). Basic KYC covers ID and selfie match; Enhanced KYC (needed for larger funding amounts or payouts) adds proof of address and additional checks. You can start verification any time from Settings → Identity Verification.",
    category: 'verification_kyc',
    tags: ['kyc', 'identity', 'verification', 'account'],
  },
  {
    question: 'What happens when I raise a dispute?',
    answer:
      "Raising a dispute on a milestone immediately pauses it (and the project) in a disputed state so no funds move while it's under review. An admin or mediator investigates, may request more evidence from either side, and records a resolution. If resolved in the contractor's favor, the milestone returns to review so the funder can re-approve it; if rejected, the milestone stays open for a corrected submission. Both the person who raised it and the other party are notified the moment it's resolved.",
    category: 'bids_contracts',
    tags: ['dispute', 'resolution', 'milestone'],
  },
  {
    question: 'How is a land listing verified before I can make an offer?',
    answer:
      "Every new land listing starts as Pending. Our team reviews the title documents and listing details before marking it Verified (safe to make offers on) or Flagged (an issue was found, e.g. a document mismatch). You can only submit a purchase offer or schedule a visit on a Verified listing — this protects buyers from unverified or disputed titles.",
    category: 'land_marketplace',
    tags: ['land', 'listing', 'verification', 'title'],
  },
  {
    question: 'How do material orders and pickup work?',
    answer:
      "Instead of handling cash for materials yourself, a contractor can request materials from a verified supplier directly against a project milestone. The order moves from Requested to Confirmed (or Rejected) by the supplier, then Out for Delivery, then Delivered — or Cancelled if it doesn't go through. Once delivered and confirmed, that order becomes the milestone's evidence and payment routes straight to the supplier on approval, not through the contractor.",
    category: 'materials_suppliers',
    tags: ['materials', 'supplier', 'order', 'delivery'],
  },
  {
    question: "I can't sign in, or I've lost access to my account. What do I do?",
    answer:
      "If you signed up with a phone number or email/password, use the \"Forgot password\" link on the sign-in screen to reset it. If you signed in with Google and it's no longer working, try linking a second sign-in method from Settings → Sign-in methods while you still have access, so you're never locked out with only one method. If you're fully locked out, use Contact Support below and include the phone number or email on the account so we can verify it's really you before restoring access.",
    category: 'account_login',
    tags: ['login', 'password', 'account', 'recovery'],
  },
  {
    question: 'How does messaging work between me and a funder, contractor, or verifier?',
    answer:
      'Every project, bid, or job has its own conversation thread you can open from the project detail screen or the Messages tab — no need to exchange phone numbers. You can send text, photos, voice notes, and documents, and you\'ll get a notification the moment the other party replies. Messages tied to a specific milestone or dispute keep that context attached so nothing gets mixed up across projects.',
    category: 'messaging',
    tags: ['messaging', 'chat', 'notifications'],
  },
  {
    question: 'What fees does Mboa Trust charge?',
    answer:
      "Mboa Trust charges a small percentage on top of the money actually moving, not a flat subscription to participate: roughly 2% when a funder sends money into a project, roughly 3% when a milestone releases escrow to a contractor or supplier, and roughly 1.5% on a verified land sale or on currency conversion between account currencies. Refunds carry no fee. Contractors and verifiers can also subscribe to a paid tier that waives certain per-bid or per-task fees — see Settings → Subscription for current pricing.",
    category: 'payments_escrow',
    tags: ['fees', 'pricing', 'subscription'],
  },
  {
    question: 'Why was my milestone evidence flagged or rejected?',
    answer:
      "Milestone photos go through an automated quality and fraud check before reaching the funder — flags usually mean a photo looked reused, lacked a readable GPS fix, or didn't match the described work. A flag doesn't reject your submission automatically; it's shown to the funder and verifier alongside your evidence so they can make the final call, and you can always resubmit with clearer photos and notes if a milestone is sent back for corrections.",
    category: 'projects_milestones',
    tags: ['milestone', 'evidence', 'fraud', 'ai inspection'],
  },
  {
    question: 'How do I withdraw money I\'ve earned?',
    answer:
      "Funds from an approved milestone are already released to your account balance automatically — nothing to claim there. From Earnings (or Payout Methods in Settings), choose \"Withdraw\" to move your available balance to your linked mobile money account or bank payout method. This records the withdrawal; the underlying funds already moved to you at approval time, so there's no separate approval step or fee at withdrawal.",
    category: 'payments_escrow',
    tags: ['withdraw', 'payout', 'earnings'],
  },
];

async function run() {
  await connectDB();
  for (const article of ARTICLES) {
    await HelpArticle.findOneAndUpdate({ question: article.question }, article, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });
    console.log(`[seed] upserted help article: ${article.question}`);
  }
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
