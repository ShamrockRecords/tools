const crypto = require('crypto');
const { getFirestore } = require('../firestore');

const CODE_EXPIRY_MILLISECONDS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

class EmailVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EmailVerificationError';
    this.code = code;
  }
}

class EmailVerificationStore {
  constructor({ firestoreProvider = getFirestore, now = () => Date.now() } = {}) {
    this.firestoreProvider = firestoreProvider;
    this.now = now;
  }

  async saveChallenge({ uid, email, code }) {
    const { salt, hash } = hashCode(code);
    const createdAt = new Date(this.now());
    const expiresAt = new Date(createdAt.getTime() + CODE_EXPIRY_MILLISECONDS);
    await this.collection.doc(uid).set({
      uid,
      email,
      salt,
      codeHash: hash,
      attempts: 0,
      createdAt,
      expiresAt,
    });
    return { expiresAt };
  }

  async verifyChallenge({ uid, code }) {
    const document = this.collection.doc(uid);
    const outcome = await this.firestoreProvider().runTransaction(async (transaction) => {
      const snapshot = await transaction.get(document);
      if (!snapshot.exists) return 'invalid';

      const challenge = snapshot.data();
      const expiresAt = asDate(challenge.expiresAt);
      if (!expiresAt || expiresAt.getTime() <= this.now()) {
        transaction.delete(document);
        return 'expired';
      }

      const attempts = Number(challenge.attempts) || 0;
      if (attempts >= MAX_ATTEMPTS) {
        return 'attempts-exceeded';
      }

      if (!verifyCode(code, challenge.salt, challenge.codeHash)) {
        transaction.update(document, { attempts: attempts + 1 });
        return attempts + 1 >= MAX_ATTEMPTS ? 'attempts-exceeded' : 'invalid';
      }

      return 'valid';
    });

    if (outcome === 'valid') return true;
    if (outcome === 'expired') {
      throw new EmailVerificationError(
        'EXPIRED_VERIFICATION_CODE',
        '認証コードの有効期限が切れています。新しいコードを送信してください。'
      );
    }
    if (outcome === 'attempts-exceeded') {
      throw new EmailVerificationError(
        'VERIFICATION_ATTEMPTS_EXCEEDED',
        '認証コードの入力回数が上限に達しました。新しいコードを送信してください。'
      );
    }
    throw invalidCodeError();
  }

  async deleteChallenge(uid) {
    await this.collection.doc(uid).delete();
  }

  get collection() {
    return this.firestoreProvider().collection('emailVerificationChallenges');
  }
}

function generateCode() {
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

function hashCode(code, salt = crypto.randomBytes(16).toString('base64')) {
  const hash = crypto.scryptSync(String(code), salt, 32).toString('base64');
  return { salt, hash };
}

function verifyCode(code, salt, expectedHash) {
  try {
    const actual = Buffer.from(hashCode(code, salt).hash, 'base64');
    const expected = Buffer.from(String(expectedHash), 'base64');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (error) {
    return false;
  }
}

function asDate(value) {
  if (value && typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function invalidCodeError() {
  return new EmailVerificationError(
    'INVALID_VERIFICATION_CODE',
    '認証コードが正しくありません。'
  );
}

module.exports = new EmailVerificationStore();
module.exports.CODE_EXPIRY_MILLISECONDS = CODE_EXPIRY_MILLISECONDS;
module.exports.EmailVerificationError = EmailVerificationError;
module.exports.EmailVerificationStore = EmailVerificationStore;
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
module.exports.generateCode = generateCode;
module.exports.hashCode = hashCode;
module.exports.verifyCode = verifyCode;
