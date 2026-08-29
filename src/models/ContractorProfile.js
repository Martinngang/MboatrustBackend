const { Schema, model } = require('mongoose');

/** A contractor's self-service trade/location/availability profile, kept
 * separate from User so non-contractor accounts never carry these fields.
 * Deliberately does NOT store rating or completed-project counts — those are
 * always computed live (see contractorProfileController.getStats) so they
 * can never go stale relative to the real Bid/Project/Rating records. */
const ContractorProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    // Free-form trade tags, matching the style of Project.category (also a
    // free string with no fixed enum) rather than inventing a stricter list
    // the rest of the codebase doesn't share.
    categories: { type: [String], default: [] },
    // Coarse region names (e.g. "Centre", "Littoral") for matching when a
    // project has no precise coordinates yet — same style as Project.locationName.
    regions: { type: [String], default: [] },
    location: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    bio: { type: String, default: '' },
    // Short professional tagline shown at the top of the public portfolio
    // (e.g. "Master Plumber — 12 years, Douala") — distinct from bio, which
    // is the longer free-text description below it.
    headline: { type: String, default: '' },
    // Free-form list of services offered (e.g. "Roof installation"), separate
    // from `categories` (the trade/specialty taxonomy the matching service
    // scores against) — a contractor can offer several services within one
    // trade category.
    services: { type: [String], default: [] },
    // Showcase gallery for the public portfolio. Not tied to a real Project
    // record on purpose — a contractor's best work often predates the
    // platform, so forcing every image to reference a real completed
    // project here would exclude legitimate portfolio material. Real
    // platform work is surfaced separately (see
    // contractorProfileController.getCompletedWork, computed live from
    // Contract/Bid — never duplicated onto this document).
    portfolioImages: {
      type: [{ url: { type: String, required: true }, caption: { type: String, default: '' } }],
      default: [],
    },
    yearsExperience: { type: Number, default: 0, min: 0 },
    // Global quick-toggle used by contractorMatchingService's scoring.
    isAvailable: { type: Boolean, default: true },
    // Per-date calendar, separate from the global toggle above — lets a
    // contractor block out (or explicitly open) specific dates without
    // changing their default availability.
    availability: {
      type: [
        {
          date: { type: Date, required: true },
          isAvailable: { type: Boolean, required: true },
        },
      ],
      default: [],
      _id: false,
    },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

ContractorProfileSchema.index({ categories: 1 });

module.exports = model('ContractorProfile', ContractorProfileSchema);
