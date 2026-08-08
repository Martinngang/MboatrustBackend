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

  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/mboatrust',

  firebase: {
    serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '',
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '',
  },
  devAuthBypass: process.env.DEV_AUTH_BYPASS === 'true',

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
  smileIdentity: {
    partnerId: process.env.SMILE_ID_PARTNER_ID || '',
    apiKey: process.env.SMILE_ID_API_KEY || '',
    sandbox: process.env.SMILE_ID_SANDBOX !== 'false',
  },
};
