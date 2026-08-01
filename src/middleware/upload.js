const multer = require('multer');

// Memory storage — buffers are streamed straight to Cloudinary, never touch disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB, generous enough for milestone evidence video
});

module.exports = upload;
