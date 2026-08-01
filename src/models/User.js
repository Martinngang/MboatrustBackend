const { Schema, model } = require('mongoose');

const AuthProviderSchema = new Schema(
  {
    provider: { type: String, enum: ['google', 'email', 'phone'], required: true },
    providerId: { type: String, required: true },
  },
  { _id: false }
);

const RoleEntrySchema = new Schema(
  {
    roleType: {
      type: String,
      enum: ['funder', 'recipient', 'contractor', 'land_seller', 'verifier', 'admin'],
      required: true,
    },
    profileRef: { type: Schema.Types.ObjectId, default: null },
  },
  { _id: false }
);

const UserSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
    },
    phoneNumber: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    passwordHash: { type: String, select: false }, // only used if a route ever creates local email accounts outside Firebase
    firebaseUid: { type: String, unique: true, sparse: true, index: true },
    authProviders: { type: [AuthProviderSchema], default: [] },
    preferredLanguage: { type: String, enum: ['en', 'fr'], default: 'en' },
    kycStatus: {
      type: String,
      enum: ['unverified', 'pending', 'verified', 'rejected'],
      default: 'unverified',
    },
    kycLevel: { type: String, enum: ['basic', 'enhanced'], default: 'basic' },
    roles: { type: [RoleEntrySchema], default: [] },
    avatarUrl: { type: String, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

UserSchema.index({ createdAt: -1 });

module.exports = model('User', UserSchema);
