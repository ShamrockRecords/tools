const firebaseAdmin = require('firebase-admin');
const {
  INVITED_UNLIMITED_CLAIM,
  isInvitedUnlimited,
} = require('./mojidas_access_policy');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

class MojidasAdminUserStore {
  constructor({ authProvider = () => firebaseAdmin.auth() } = {}) {
    this.authProvider = authProvider;
  }

  async listUsers({ pageToken = null, pageSize = DEFAULT_PAGE_SIZE } = {}) {
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE));
    const result = await this.authProvider().listUsers(limit, pageToken || undefined);

    return {
      users: result.users.map((user) => ({
        uid: user.uid,
        email: user.email || null,
        emailVerified: Boolean(user.emailVerified),
        disabled: Boolean(user.disabled),
        createdAt: user.metadata ? user.metadata.creationTime || null : null,
        lastSignInAt: user.metadata ? user.metadata.lastSignInTime || null : null,
        invitedUnlimited: isInvitedUnlimited(user),
      })),
      nextPageToken: result.pageToken || null,
    };
  }

  async setInvitedUnlimited({ uid, enabled }) {
    const auth = this.authProvider();
    const user = await auth.getUser(uid);
    const claims = { ...(user.customClaims || {}) };

    if (enabled) {
      claims[INVITED_UNLIMITED_CLAIM] = true;
    } else {
      delete claims[INVITED_UNLIMITED_CLAIM];
    }

    await auth.setCustomUserClaims(uid, claims);
    return { uid, invitedUnlimited: Boolean(enabled) };
  }
}

module.exports = new MojidasAdminUserStore();
module.exports.DEFAULT_PAGE_SIZE = DEFAULT_PAGE_SIZE;
module.exports.MojidasAdminUserStore = MojidasAdminUserStore;
