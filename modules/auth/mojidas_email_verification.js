const emailVerificationStore = require('./email_verification_store');
const { generateCode } = emailVerificationStore;
const { MojidasVerificationEmailSender } = require('./mojidas_verification_email');

class MojidasEmailVerificationService {
  constructor({ firebaseAdmin, store = emailVerificationStore, emailSender } = {}) {
    this.firebaseAdmin = firebaseAdmin;
    this.store = store;
    this.emailSender = emailSender || new MojidasVerificationEmailSender();
  }

  async issue({ uid, email }) {
    const code = generateCode();
    const challenge = await this.store.saveChallenge({ uid, email, code });
    try {
      await this.emailSender.send(email, code);
      return challenge;
    } catch (error) {
      await this.store.deleteChallenge(uid).catch(() => {});
      throw error;
    }
  }

  async verify({ email, code }) {
    let user;
    try {
      user = await this.firebaseAdmin.auth().getUserByEmail(email);
    } catch (error) {
      throw invalidCodeError();
    }

    if (user.emailVerified) {
      await this.store.deleteChallenge(user.uid).catch(() => {});
      return user;
    }

    await this.store.verifyChallenge({ uid: user.uid, code });
    const verifiedUser = await this.firebaseAdmin.auth().updateUser(user.uid, {
      emailVerified: true,
    });
    await this.store.deleteChallenge(user.uid);
    return verifiedUser;
  }
}

function invalidCodeError() {
  const error = new Error('認証コードが正しくありません。');
  error.code = 'INVALID_VERIFICATION_CODE';
  return error;
}

module.exports = {
  MojidasEmailVerificationService,
};
