// Firebase Admin 14のモジュールAPIを使い、既存の注入インターフェースを維持する。
const app = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const firestore = () => getFirestore();
firestore.FieldValue = FieldValue;
module.exports = {
  get apps() { return app.getApps(); },
  initializeApp: app.initializeApp,
  credential: { cert: app.cert },
  auth: () => getAuth(),
  firestore,
  storage: () => getStorage(),
};
