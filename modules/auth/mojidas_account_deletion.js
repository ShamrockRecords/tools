const crypto = require('crypto');
const firebaseAdmin = require('firebase-admin');

const { getFirestore, serverTimestamp } = require('../firestore');
const { mojidasCollection } = require('../mojidas_firestore');

const ACCOUNT_DELETION_SECRET_KEY = 'MOJIDAS_ACCOUNT_DELETION_SECRET';
const DELETE_BATCH_SIZE = 200;

class AccountDeletionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AccountDeletionError';
    this.code = code;
  }
}

class MojidasAccountDeletionService {
  constructor({
    firestoreProvider = getFirestore,
    authProvider = () => firebaseAdmin.auth(),
    environment = process.env,
    timestampProvider = serverTimestamp,
  } = {}) {
    this.firestoreProvider = firestoreProvider;
    this.authProvider = authProvider;
    this.environment = environment;
    this.timestampProvider = timestampProvider;
  }

  async isEmailDeleted(email) {
    const digest = this.emailDigest(email);
    const snapshot = await this.collection('deletedAccountEmails').doc(digest).get();
    return snapshot.exists;
  }

  async deleteAccount({ userID, email }) {
    const normalizedUserID = String(userID || '').trim();
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedUserID || !normalizedEmail) {
      throw new AccountDeletionError(
        'INVALID_ACCOUNT',
        '削除するアカウントを確認できませんでした。'
      );
    }

    const digest = this.emailDigest(normalizedEmail);
    await this.collection('deletedAccountEmails').doc(digest).set({
      schemaVersion: 1,
      emailDigest: digest,
      deletedAt: this.timestampProvider(),
    }, { merge: true });

    // Tombstoneを先に永続化することで、以後はFirebase Authの削除後も
    // 同じメールアドレスから新しいアカウントを作成できない。
    const auth = this.authProvider();
    await auth.updateUser(normalizedUserID, { disabled: true });
    await auth.revokeRefreshTokens(normalizedUserID);
    await this.deleteUserData(normalizedUserID);

    try {
      await auth.deleteUser(normalizedUserID);
    } catch (error) {
      if (!isFirebaseUserNotFound(error)) throw error;
    }

    // 無効化直前に認証を通過済みだったrequestが書き込んだデータも除去する。
    await this.deleteUserData(normalizedUserID);

    return { deleted: true };
  }

  async deleteUserData(userID) {
    const firestore = this.firestore;
    const dictionaryAccounts = await this.collection('dictionaryAccounts')
      .where('userID', '==', userID)
      .get();
    for (const document of dictionaryAccounts.docs) {
      await firestore.recursiveDelete(document.ref);
    }

    for (const collectionName of [
      'creditGrants',
      'creditReservations',
      'usageLedger',
      'dictionaryClients',
    ]) {
      await this.deleteQuery(
        this.collection(collectionName).where('userID', '==', userID)
      );
    }

    await Promise.all([
      this.collection('emailVerificationChallenges').doc(userID).delete(),
      this.collection('users').doc(userID).delete(),
    ]);
  }

  async deleteQuery(query) {
    while (true) {
      const snapshot = await query.limit(DELETE_BATCH_SIZE).get();
      if (snapshot.empty) return;
      const batch = this.firestore.batch();
      snapshot.docs.forEach((document) => batch.delete(document.ref));
      await batch.commit();
      if (snapshot.size < DELETE_BATCH_SIZE) return;
    }
  }

  emailDigest(email) {
    const secret = String(this.environment[ACCOUNT_DELETION_SECRET_KEY] || '').trim();
    if (secret.length < 32) {
      throw new AccountDeletionError(
        'ACCOUNT_DELETION_NOT_CONFIGURED',
        `${ACCOUNT_DELETION_SECRET_KEY}を32文字以上で設定してください。`
      );
    }
    return crypto
      .createHmac('sha256', secret)
      .update(normalizeEmail(email), 'utf8')
      .digest('hex');
  }

  get firestore() {
    return this.firestoreProvider();
  }

  collection(name) {
    return mojidasCollection(this.firestore, name);
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase().normalize('NFC');
}

function isFirebaseUserNotFound(error) {
  return error && (error.code === 'auth/user-not-found' || error.code === 'USER_NOT_FOUND');
}

const mojidasAccountDeletionService = new MojidasAccountDeletionService();

module.exports = {
  ACCOUNT_DELETION_SECRET_KEY,
  AccountDeletionError,
  MojidasAccountDeletionService,
  mojidasAccountDeletionService,
  normalizeEmail,
};
