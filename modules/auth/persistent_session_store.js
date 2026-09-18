const session = require('express-session');
const crypto = require('crypto');
const { getFirestore } = require('../firestore');
const { mojidasCollection } = require('../mojidas_firestore');

const LOGIN_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

class PersistentSessionStore extends session.Store {
  constructor({ scope, firestoreProvider = getFirestore, now = Date.now }) {
    super();
    this.scope = scope;
    this.firestoreProvider = firestoreProvider;
    this.now = now;
  }

  document(sid) {
    const id = crypto.createHash('sha256').update(`${this.scope}:${sid}`).digest('hex');
    return mojidasCollection(this.firestoreProvider(), 'webSessions').doc(id);
  }

  get(sid, callback) {
    Promise.resolve().then(async () => {
      const snapshot = await this.document(sid).get();
      if (!snapshot.exists) return null;
      const row = snapshot.data();
      const expiry = row.expiresAt?.toDate ? row.expiresAt.toDate() : new Date(row.expiresAt);
      if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= this.now()) return null;
      return JSON.parse(row.payload);
    }).then(value => callback(null, value), callback);
  }

  set(sid, value, callback = () => {}) {
    Promise.resolve().then(async () => {
      const loginAt = this.scope === 'partner' ? value.partnerLogin?.at : Date.parse(value.adminUser?.signedInAt);
      const cookieExpiry = Date.parse(value.cookie?.expires);
      const expiresAt = new Date(Math.min(
        Number.isFinite(cookieExpiry) ? cookieExpiry : this.now() + LOGIN_DURATION_MS,
        Number.isFinite(loginAt) ? loginAt + LOGIN_DURATION_MS : this.now() + LOGIN_DURATION_MS
      ));
      await this.document(sid).set({ payload: JSON.stringify(value), expiresAt });
    }).then(() => callback(), callback);
  }

  destroy(sid, callback = () => {}) {
    Promise.resolve().then(() => this.document(sid).delete()).then(() => callback(), callback);
  }

  // 読み取りだけでは期限を延長しない。ログインから30日で再認証する。
  touch(sid, value, callback = () => {}) { callback(); }
}

module.exports = { PersistentSessionStore, LOGIN_DURATION_MS };
