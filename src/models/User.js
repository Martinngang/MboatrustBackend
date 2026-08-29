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
      enum: ['funder', 'recipient', 'contractor', 'land_seller', 'verifier', 'admin', 'quincaillerie'],
      required: true,
    },
    profileRef: { type: Schema.Types.ObjectId, default: null },
  },
  { _id: false }
);

// Saved payout destinations — recipients, contractors, and sellers store their
// MoMo/OM phone numbers here so withdrawals and milestone releases can be
// routed to the right account without re-entering details each time.
const PayoutMethodSchema = new Schema(
  {
    label: { type: String, default: '' },
    provider: { type: String, enum: ['mtn_momo', 'orange_money'], required: true },
    phoneNumber: { type: String, required: true },
    isDefault: { type: Boolean, default: false },
  },
  { _id: true }
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
    // Set once, at the end of the registration flow (ProfileSetupScreen) —
    // the frontend's sole source of truth for "has this account finished
    // onboarding", so a returning user is never asked to pick a role again
    // just because e.g. they abandoned profile setup with roles already
    // saved. See api/session.ts's resolveAuthDestination on the client.
    onboardingCompleted: { type: Boolean, default: false },
    // Diaspora funder's country/city of residence, set during onboarding
    // (ProfileSetupScreen). residenceCountry is a real ISO 3166-1 alpha-2
    // code (see utils/locationData.ts on the frontend, backed by the
    // country-state-city dataset) rather than a free-text guess — city is
    // that country's real locality name, not validated against a fixed
    // enum here since the dataset is too large to mirror server-side.
    residenceCountry: { type: String, default: '' },
    residenceCity: { type: String, default: '' },
    payoutMethods: { type: [PayoutMethodSchema], default: [] },
    avatarUrl: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    // Firebase Cloud Messaging token for the device currently signed in —
    // set via POST /users/me/device-token. Single token, not an array: good
    // enough for "push works on whichever device last registered," which is
    // the scope this backend needs; a real multi-device inbox would need a
    // token-per-device list instead.
    fcmDeviceToken: { type: String, default: null },
    // Fine-grained admin RBAC, additive on top of the flat roleType:'admin'
    // check — absent/null means unrestricted (every admin created before
    // this field existed, including the INITIAL_ADMIN_EMAIL bootstrap
    // account, keeps full access with zero migration). Only meaningful for
    // users with an 'admin' role entry; see middleware/auth.js's
    // requireAdminPermission. Keys mirror ADMIN_NAV's section keys on the
    // frontend (components/shell/adminNav.ts).
    adminPermissions: { type: [String], default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

UserSchema.index({ createdAt: -1 });

module.exports = model('User', UserSchema);
