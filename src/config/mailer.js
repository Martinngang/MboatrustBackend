const nodemailer = require('nodemailer');

/** Builds a fresh transporter from an already-resolved config object (see
 * services/smtpSettingsService.js) — deliberately not cached as a
 * singleton the way earlier versions of this file were: nodemailer
 * transporter creation is cheap (it doesn't dial out until sendMail is
 * called), and rebuilding it per-send is what makes an admin's settings
 * change — including flipping the enabled switch off — take effect on the
 * very next email with no server restart. */
function buildTransporter(config) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });
}

module.exports = { buildTransporter };
