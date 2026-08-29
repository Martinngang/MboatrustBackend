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
    console.warn('[storageService] Cloudinary credentials not set — falling back to data URLs for uploads');
  }
  configured = true;
}

/**
 * Uploads a buffer (from multer memory storage) to Cloudinary or falls back to data URL.
 */
function uploadBuffer(buffer, { folder = 'mboatrust/evidence', resourceType = 'auto', mimeType = 'image/png' } = {}) {
  ensureConfigured();
  return new Promise((resolve) => {
    if (!env.cloudinary.cloudName || !env.cloudinary.apiKey || !env.cloudinary.apiSecret) {
      const base64 = buffer.toString('base64');
      const url = `data:${mimeType};base64,${base64}`;
      return resolve({ secure_url: url, url });
    }
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType },
      (err, result) => {
        if (err) {
          console.warn('[storageService] Cloudinary upload failed, falling back to data URL:', err.message);
          const base64 = buffer.toString('base64');
          const url = `data:${mimeType};base64,${base64}`;
          return resolve({ secure_url: url, url });
        }
        return resolve(result);
      }
    );
    stream.end(buffer);
  });
}

module.exports = { uploadBuffer };
