const firebaseAdmin = require('firebase-admin');

function getFirestore() {
  if (!firebaseAdmin.apps.length) {
    throw new Error(
      'Firebase Admin SDKが初期化されていません。FIREBASE_ADMIN_CREDENTIALSを確認してください。'
    );
  }

  return firebaseAdmin.firestore();
}

function serverTimestamp() {
  return firebaseAdmin.firestore.FieldValue.serverTimestamp();
}

module.exports = {
  getFirestore,
  serverTimestamp,
};
