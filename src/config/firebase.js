const fs = require('fs');
const admin = require('firebase-admin');
const { firebase, devAuthBypass } = require('./env');

let initialized = false;

function initFirebase() {
  if (initialized || admin.apps.length) return admin;

  let credential;
  if (firebase.serviceAccountJson) {
    credential = admin.credential.cert(JSON.parse(firebase.serviceAccountJson));
  } else if (firebase.serviceAccountPath && fs.existsSync(firebase.serviceAccountPath)) {
    credential = admin.credential.cert(JSON.parse(fs.readFileSync(firebase.serviceAccountPath, 'utf8')));
  } else {
    if (!devAuthBypass) {
      console.warn(
        '[firebase] No service account configured and DEV_AUTH_BYPASS is off — protected routes will reject all requests.'
      );
    }
    return null;
  }

  admin.initializeApp({ credential });
  initialized = true;
  return admin;
}

module.exports = { initFirebase };
