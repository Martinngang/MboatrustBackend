const cloudinary = require('cloudinary').v2;
const env = require('../config/env');

let configured = false;

function ensureConfigured() {
  if (configured) return;
  if (env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret) {
    cloudinary.config({
      cloud_name: env.cloudinary.cloudName,
      api_key: env.cloudinary.apiKey,
      api_secret: env.cloudinary.apiSecret,
    });
  } else {
    console.warn('[storageService] Cloudinary credentials not set — uploads will fail until configured');
  }
  configured = true;
}

/**
 * Uploads a buffer (from multer memory storage) to Cloudinary and
 * returns the secure URL used as Evidence.fileUrl / LandDocument.fileUrl.
 */
function uploadBuffer(buffer, { folder = 'mboatrust/evidence', resourceType = 'auto' } = {}) {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

module.exports = { uploadBuffer };
