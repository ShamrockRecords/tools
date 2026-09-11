const firebaseAdmin = require('firebase-admin');
const creditStore = require('../credit/mojidas_credit_store');
const MAX_ADDED_HOURS = 100000;
const {
  INVITED_UNLIMITED_CLAIM,
  isInvitedUnlimited,
} = require('./mojidas_access_policy');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

class MojidasAdminUserStore {
  constructor({ authProvider = () => firebaseAdmin.auth(), credits = creditStore } = {}) {
    this.credits = credits;
    this.authProvider = authProvider;
  }

  async listUsers({ pageToken = null, pageSize = DEFAULT_PAGE_SIZE } = {}) {
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE));
    const result = await this.authProvider().listUsers(limit, pageToken || undefined);

    return {
      users: await Promise.all(result.users.map(async (user) => ({
        uid: user.uid,
        email: user.email || null,
        emailVerified: Boolean(user.emailVerified),
        disabled: Boolean(user.disabled),
        createdAt: user.metadata ? user.metadata.creationTime || null : null,
        lastSignInAt: user.metadata ? user.metadata.lastSignInTime || null : null,
        invitedUnlimited: isInvitedUnlimited(user),
        credit: await this.getUserCredit(user),
      }))),
      nextPageToken: result.pageToken || null,
    };
  }

  async getUserCredit(user) {
    try {
      const balance = await this.credits.getBalance({
        userID: user.uid,
        accountCreatedAt: user.metadata?.creationTime || null,
        isUnlimited: isInvitedUnlimited(user),
      });
      const sum = (type) => balance.grants.filter((grant) => grant.type === type)
        .reduce((total, grant) => total + grant.remainingMilliseconds, 0);
      return {
        monthlyFreeMilliseconds: sum('monthlyFree'),
        purchasedMilliseconds: sum('purchased'),
        promotionalMilliseconds: sum('promotional'),
        totalMilliseconds: balance.availableMilliseconds,
        otherMilliseconds: balance.availableMilliseconds - sum('monthlyFree') - sum('purchased') - sum('promotional'),
      };
    } catch (error) {
      // 取得失敗を残高ゼロと誤表示しない。他のユーザーの管理は継続できる。
      return null;
    }
  }

  async addPromotionalHours({ uid, hours, operationID, adminEmail, reason }) {
    const value = String(hours ?? '');
    if (!uid || typeof uid !== 'string' || uid.length > 128
      || !/^[1-9][0-9]*$/.test(value) || Number(value) > MAX_ADDED_HOURS
      || typeof operationID !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationID)) {
      throw Object.assign(new Error('追加時間は1〜100,000の整数で入力してください。画面を再読込してから操作してください。'), { code: 'INVALID_ADMIN_CREDIT' });
    }
    // 存在しないアカウントへの付与を防ぐ。既存残高の上書きはしない。
    await this.authProvider().getUser(uid);
    return this.credits.grantCredit({
      userID: uid, type: 'promotional', label: '無償提供（プロモーション等）',
      milliseconds: Number(value) * 3600000,
      idempotencyKey: `admin-promotional:${operationID.toLowerCase()}`,
      rejectConflictingRetry: true,
      metadata: { source: 'admin', adminEmail, hours: Number(value),
        reason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : 'プロモーション' },
    });
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
