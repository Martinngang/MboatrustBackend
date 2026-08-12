const { Schema, model } = require('mongoose');

/** A real negotiation step in front of landListingController.purchase() —
 * buyer proposes a price, seller can counter, either side can accept or
 * decline, buyer can withdraw. Only on `accept` does a real land_purchase
 * Project get created (via createPurchaseProject), at whatever amount was
 * actually agreed — never the buyer's original offer if a counter happened. */
const LandOfferSchema = new Schema(
  {
    listingId: { type: Schema.Types.ObjectId, ref: 'LandListing', required: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    offerAmount: { type: Number, required: true, min: 0 },
    message: { type: String, default: '' },
    status: {
      type: String,
      enum: ['pending', 'countered', 'accepted', 'declined', 'withdrawn'],
      default: 'pending',
    },
    counterAmount: { type: Number, default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

LandOfferSchema.index({ listingId: 1, status: 1 });
LandOfferSchema.index({ buyerId: 1 });

module.exports = model('LandOffer', LandOfferSchema);
