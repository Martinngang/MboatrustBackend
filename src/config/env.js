const dotenv = require('dotenv');

dotenv.config();

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 5000,
  // Comma-separated in dev since the Vite frontend's port varies by project config.
  clientOrigins: (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map((s) => s.trim()),
  // Used to build absolute return/cancel/notification URLs for redirect-based
  // payment flows (Orange Money webpayment) — must be publicly reachable in
  // production for the notif_url webhook to work.
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:5000',

  // Express's `trust proxy` — off (false) by default, matching Express's own
  // safe default. Deployed behind exactly one reverse proxy (Render, Heroku,
  // Railway, a single nginx hop — the standard topology), this MUST be set
  // to "1" or req.ip silently becomes the proxy's own address for every
  // request: the rate limiter (see app.js) keys on req.ip, so every distinct
  // user gets bucketed together under one shared limit instead of their own.
  // Only set this to the real number of trusted proxy hops in front of the
  // app — trusting a hop that isn't really there lets a client spoof its own
  // X-Forwarded-For header and bypass IP-based rate limiting entirely.
  trustProxy: process.env.TRUST_PROXY ? (Number.isNaN(Number(process.env.TRUST_PROXY)) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY)) : false,

  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/mboatrust',

  // Symmetric key protecting secrets an admin stores through the dashboard
  // (currently just the SMTP password — see models/SmtpSettings.js and
  // utils/crypto.js) at rest in MongoDB. Hashed down to a 32-byte AES-256
  // key regardless of the literal value set here, so any real passphrase
  // works — it does not need to be pre-formatted hex. Deliberately NOT
  // defaulted to a fixed fallback the way most of this file's other
  // integrations are: silently falling back would mean a secret meant to be
  // encrypted gets protected by a key every deployment of this codebase
  // shares, which is materially worse than refusing to store it at all (see
  // utils/crypto.js, which throws rather than degrading when this is unset).
  settingsEncryptionKey: process.env.SETTINGS_ENCRYPTION_KEY || '',

  firebase: {
    serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '',
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '',
  },
  devAuthBypass: process.env.DEV_AUTH_BYPASS === 'true',

  // Granting 'admin' requires an existing admin (see adminUserRoutes.js) —
  // with zero admins, nobody could ever reach that endpoint, so a fresh
  // production database has no path to its first one. Set this once, to
  // the email of a real account that has already signed up, and
  // bootstrapAdmin.js grants it admin on the next server start; leaving it
  // set afterward is a harmless no-op (see that file). Never used to create
  // an account — only to promote one that already exists.
  initialAdminEmail: (process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase(),

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  },

  momo: {
    baseUrl: process.env.MOMO_SANDBOX_BASE_URL || 'https://sandbox.momodeveloper.mtn.com',
    // MTN issues a separate subscription key per product you subscribe to
    // (Collections vs Disbursements) — falls back to the Collections key if
    // no separate Disbursements key is set, since some setups share one.
    subscriptionKey: process.env.MOMO_SUBSCRIPTION_KEY || '',
    disbursementSubscriptionKey: process.env.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY || process.env.MOMO_SUBSCRIPTION_KEY || '',
    apiUser: process.env.MOMO_API_USER || '',
    apiKey: process.env.MOMO_API_KEY || '',
    // Was hardcoded to 'sandbox' directly in mtnMomoProvider's request
    // headers with no way to switch it — meant "enabling for production"
    // was impossible without a code change. Defaults to sandbox so nothing
    // changes until this is explicitly set.
    targetEnvironment: process.env.MOMO_ENV === 'production' ? 'production' : 'sandbox',
  },
  orangeMoney: {
    baseUrl: process.env.OM_SANDBOX_BASE_URL || 'https://api.orange.com/orange-money-webpay/dev/v1',
    merchantKey: process.env.OM_MERCHANT_KEY || '',
    clientId: process.env.OM_CLIENT_ID || '',
    clientSecret: process.env.OM_CLIENT_SECRET || '',
  },
  flutterwave: {
    baseUrl: process.env.FLUTTERWAVE_BASE_URL || 'https://api.flutterwave.com',
    publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY || '',
    secretKey: process.env.FLUTTERWAVE_SECRET_KEY || '',
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || ''
  },
  smileIdentity: {
    partnerId: process.env.SMILE_ID_PARTNER_ID || '',
    apiKey: process.env.SMILE_ID_API_KEY || '',
    sandbox: process.env.SMILE_ID_SANDBOX !== 'false',
  },

  // Transactional email — degrades to a no-op (see mailerService.js) when
  // unset, same convention as firebase/momo/orangeMoney above. Works with
  // any real SMTP provider (Gmail app password, SendGrid/Mailgun/SES SMTP
  // relay, a custom mail server) since it's just standard SMTP, not a
  // provider-specific API.
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || process.env.SMTP_USER || '',
  },

  // Optional AI layer (Gemini) on top of the deterministic fraud checks and
  // heuristic contractor scoring — see services/aiClient.js. Every feature
  // that reads this must degrade to heuristic-only when geminiApiKey is
  // blank, never throw.
  ai: {
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    fraudAnalysisEnabled: process.env.AI_FRAUD_ANALYSIS_ENABLED !== 'false',
    matchingRationaleEnabled: process.env.AI_MATCHING_RATIONALE_ENABLED !== 'false',
  },
};
