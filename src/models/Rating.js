const { Schema, model } = require('mongoose');

const RatingSchema = new Schema(
  {
    fromUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    toUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    score: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: '' },
    roleContext: {
      type: String,
      enum: ['contractor', 'verifier', 'land_seller', 'supplier'],
      required: true,
    },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

RatingSchema.index({ toUserId: 1 });
RatingSchema.index({ projectId: 1 });

module.exports = model('Rating', RatingSchema);
