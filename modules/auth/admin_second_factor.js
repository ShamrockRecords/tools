const crypto = require('crypto');
const { getFirestore } = require('../firestore');
const { mojidasCollection } = require('../mojidas_firestore');
const IDLE_MS = 3 * 24 * 60 * 60 * 1000;
const CODE_MS = 10 * 60 * 1000;

class AdminChallengeStore {
  constructor({ persistent = false, firestoreProvider = getFirestore, now = Date.now } = {}) {
    this.persistent = persistent;
    this.firestoreProvider = firestoreProvider;
    this.now = now;
    this.memory = new Map();
  }

  document(id) {
    return mojidasCollection(this.firestoreProvider(), 'adminLoginChallenges').doc(id);
  }

  async create(email) {
    const id = crypto.randomBytes(32).toString('hex');
    const code = crypto.randomInt(1000000).toString().padStart(6, '0');
    const row = { email, hash: this.hash(id, code), expiresAt: this.now() + CODE_MS, attempts: 0 };
    if (this.persistent) await this.document(id).set(row);
    else {
      for (const [key, value] of this.memory) if (value.expiresAt <= this.now()) this.memory.delete(key);
      this.memory.set(id, row);
    }
    return { id, code };
  }

  hash(id, code) {
    return crypto.scryptSync(String(code), id, 32).toString('hex');
  }

  async remove(id) {
    if (this.persistent) await this.document(id).delete();
    else this.memory.delete(id);
  }

  async consume(id, code) {
    const check = (row, write, remove) => {
      if (!row || row.expiresAt <= this.now() || row.attempts >= 5) { remove(); return null; }
      const actual = Buffer.from(this.hash(id, String(code)), 'hex');
      const expected = Buffer.from(row.hash, 'hex');
      if (!/^\d{6}$/.test(code) || expected.length !== actual.length || !crypto.timingSafeEqual(actual, expected)) {
        write({ ...row, attempts: row.attempts + 1 });
        return null;
      }
      remove();
      return { email: row.email };
    };
    if (!this.persistent) return check(this.memory.get(id), row => this.memory.set(id, row), () => this.memory.delete(id));
    const ref = this.document(id);
    return this.firestoreProvider().runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      return check(snapshot.exists ? snapshot.data() : null, row => tx.set(ref, row), () => tx.delete(ref));
    });
  }
}

function adminActivity(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const now = req.app.locals.adminAuthNow ? req.app.locals.adminAuthNow() : Date.now();
  const user = req.session.adminUser;
  if (user) {
    if (user.secondFactorVerified !== true || !Number.isFinite(user.lastAccessAt)
      || now - user.lastAccessAt >= IDLE_MS || user.lastAccessAt > now) {
      delete req.session.adminUser;
      req.session.adminError = '再度ログインしてください。';
    } else {
      user.lastAccessAt = now;
      req.session.cookie.maxAge = IDLE_MS;
    }
  }
  next();
}

module.exports = { AdminChallengeStore, adminActivity, IDLE_MS, CODE_MS };
