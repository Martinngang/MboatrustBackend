const multer = require('multer');
const ApiError = require('../utils/ApiError');

// One shared instance across every upload route (milestone evidence, land
// documents, certifications, avatars, KYC documents) — all legitimately
// images, video, or PDFs. Without this, multer's default is to accept any
// file type at all, letting anyone upload an arbitrary executable/script as
// "milestone evidence" and have it streamed straight to Cloudinary.
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime', 'video/webm',
  'application/pdf',
]);

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return cb(ApiError.badRequest(`Unsupported file type "${file.mimetype}" — only images, video, and PDF are accepted`));
  }
  cb(null, true);
}

// Memory storage — buffers are streamed straight to Cloudinary, never touch disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB, generous enough for milestone evidence video
  fileFilter,
});

module.exports = upload;
