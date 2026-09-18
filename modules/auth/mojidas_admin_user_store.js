const firebaseAdmin = require('firebase-admin');
const { getFirestore } = require('../firestore');
const { mojidasCollection } = require('../mojidas_firestore');
const creditStore = require('../credit/mojidas_credit_store');
const { PartnerStore } = require('../partners/partner_store');
const MAX_ADDED_HOURS = 100000;
const {
  INVITED_UNLIMITED_CLAIM,
  isInvitedUnlimited,
} = require('./mojidas_access_policy');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const { userStatistics } = require('./mojidas_user_statistics');

class MojidasAdminUserStore {
  constructor({ authProvider = () => firebaseAdmin.auth(), credits = creditStore, firestoreProvider = getFirestore, partners } = {}) {
    this.credits = credits;
    this.authProvider = authProvider;
    this.firestoreProvider = firestoreProvider;
    this.partners = partners || new PartnerStore({ firestoreProvider });
  }

  async listUsers({ page, pageToken = null, pageSize = DEFAULT_PAGE_SIZE } = {}) {
    const limit = Math.floor(Math.min(MAX_PAGE_SIZE, Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE)));
    // Authの取得順ではなく、全アカウントの作成日時で並べてからページ分割する。
    const auth = this.authProvider();
    const allUsers = [];
    let token;
    do {
      const batch = await auth.listUsers(1000, token);
      allUsers.push(...batch.users);
      token = batch.pageToken;
    } while (token);
    const createdTime = (user) => Date.parse(user.metadata?.creationTime) || 0;
    allUsers.sort((a, b) => createdTime(b) - createdTime(a) || a.uid.localeCompare(b.uid));
    const totalUsers = allUsers.length;
    const totalPages = Math.max(1, Math.ceil(totalUsers / limit));
    const legacyOffset = /^created-desc:\d+$/.test(pageToken || '') ? Number(pageToken.split(':')[1]) : 0;
    const requestedPage = page === undefined ? Math.floor(legacyOffset / limit) + 1 : Number(page);
    const currentPage = Math.min(totalPages, Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1);
    const offset = (currentPage - 1) * limit;
    const result = { users: allUsers.slice(offset, offset + limit) };
    let clients = new Map();
    if (allUsers.length) {
      try {
        const snapshot = await mojidasCollection(this.firestoreProvider(), 'users').select('appClients').get();
        clients = new Map(snapshot.docs.map(doc => [doc.id, doc.data().appClients]));
      } catch {
        clients = null;
      }
    }

    return {
      statistics: userStatistics(allUsers, clients),
      page: currentPage,
      totalUsers,
      totalPages,
      startIndex: totalUsers ? offset + 1 : 0,
      endIndex: Math.min(offset + limit, totalUsers),
      users: await Promise.all(result.users.map(async (user) => ({
        uid: user.uid,
        email: user.email || null,
        emailVerified: Boolean(user.emailVerified),
        disabled: Boolean(user.disabled),
        createdAt: user.metadata ? user.metadata.creationTime || null : null,
        lastSignInAt: user.metadata ? user.metadata.lastSignInTime || null : null,
        invitedUnlimited: isInvitedUnlimited(user),
        isCorporate: await this.getCorporateStatus(user),
        credit: await this.getUserCredit(user),
        appClients: await this.getAppClients(user.uid),
      }))),
      nextPageToken: offset + limit < allUsers.length ? `created-desc:${offset + limit}` : null,
    };
  }

  async getCorporateStatus(user) {
    try {
      return Boolean(await this.partners.entitlement(user));
    } catch {
      // 障害時に通常ユーザーと誤表示しない。
      return null;
    }
  }

  async getAppClients(uid) {
    try {
      const snapshot = await mojidasCollection(this.firestoreProvider(), 'users').doc(uid).get();
      const clients = snapshot.exists ? snapshot.data().appClients : null;
      const result = {};
      for (const platform of ['macos', 'windows']) {
        const client = clients?.[platform];
        const pattern = platform === 'macos' ? /^\d+\.\d+\.\d+$/ : /^\d+\.\d+\.\d+\.\d+$/;
        if (!client || typeof client.version !== 'string' || client.version.length > 40 || !pattern.test(client.version)) {
          result[platform] = null;
          continue;
        }
        const rawDate = client.lastSeenAt?.toDate ? client.lastSeenAt.toDate() : client.lastSeenAt;
        const date = rawDate ? new Date(rawDate) : null;
        result[platform] = { version: client.version,
          lastSeenAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null };
      }
      return result;
    } catch {
      // 未取得と通信障害を区別し、他のユーザー情報は表示する。
      return null;
    }
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
