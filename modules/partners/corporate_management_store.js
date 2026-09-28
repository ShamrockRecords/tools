const { mojidasCollection } = require('../mojidas_firestore');
const { normalizeDomain } = require('./domain_policy');
const { periodAt, quotaStatus, boundary } = require('./quota_policy');
const { monthAt } = require('./usage_policy');
const { memberRef, enrollMember } = require('./corporate_membership');

const emailDomain = email => normalizeDomain(String(email || '').split('@')[1]);
const fail = () => { throw new Error('この法人ドメインまたはアカウントは操作できません。'); };
const monthlyFees = { metered: 2200, light: 13200, standard: 24200 };
function estimate(plan, excess) {
  if (plan === 'trial') return { base: 0, minutes: 0, excess: 0, total: 0 };
  // 請求ではなく概算。月合計の超過を分単位に切り上げ、円の端数は保持する。
  const minutes = Math.ceil(excess / 60000), charge = minutes * 5.5;
  return { base: monthlyFees[plan] ?? null, minutes, excess: charge,
    total: monthlyFees[plan] == null ? null : monthlyFees[plan] + charge };
}
class CorporateManagementStore {
  constructor({ firestoreProvider, now = Date.now, authProvider = () => require('firebase-admin').auth() }) {
    this.provider = firestoreProvider; this.now = now; this.authProvider = authProvider;
  }
  collection(name) { return mojidasCollection(this.provider(), name); }
  async owned(login, domain, tx) {
    if (!login?.id || login.mustChangePassword || normalizeDomain(domain) !== domain) fail();
    const ref = this.collection('corporateDomains').doc(domain);
    const row = await (tx ? tx.get(ref) : ref.get());
    if (!row.exists || row.data().portalAccountID !== login.id) fail();
    return { ref, data: row.data() };
  }
  async policy(login, input) {
    if (!['auto', 'manual'].includes(input.mode)) fail();
    return this.provider().runTransaction(async tx => {
      const { ref } = await this.owned(login, input.domain, tx);
      tx.update(ref, { autoEnableMembers: input.mode === 'auto', memberPolicyUpdatedAt: this.now(), memberPolicyUpdatedBy: login.id });
    });
  }
  async setMembers(login, input) {
    const ids = [...new Set(Array.isArray(input.userIDs) ? input.userIDs : [input.userIDs])];
    if (!['enable', 'disable'].includes(input.action) || !ids.length || ids.length > 100
      || ids.some(id => typeof id !== 'string' || !id || id.length > 128 || id.includes('/'))) fail();
    await this.owned(login, input.domain);
    const users = await Promise.all(ids.map(uid => this.authProvider().getUser(uid)));
    if (users.some(user => emailDomain(user.email) !== input.domain)) fail();
    await this.provider().runTransaction(async tx => {
      await this.owned(login, input.domain, tx);
      for (const user of users) tx.set(memberRef(this.provider(), input.domain, user.uid), {
        domain: input.domain, userID: user.uid, enabled: input.action === 'enable', updatedBy: login.id, updatedAt: this.now(),
      });
    });
  }
  async overview(login, input = {}) {
    const domain = input.domain;
    const { data } = await this.owned(login, domain);
    const month = input.month || monthAt(this.now());
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('対象月を確認してください。');
    const query = typeof input.q === 'string' ? input.q.trim().toLowerCase().slice(0, 254) : '';
    const [year, number] = month.split('-').map(Number);
    const period = periodAt(boundary(year, number - 1, 1), data);
    const ledger = await this.collection('corporateUsageLedger').where('domain', '==', domain)
      .where('occurredAt', '>=', new Date(period.start)).where('occurredAt', '<', new Date(period.end)).get();
    const usage = { realtime: 0, mediaFile: 0, formalTranslation: 0 }, perUser = new Map(), reservations = new Map();
    for (const entry of ledger.docs) {
      const item = entry.data();
      if (!Object.hasOwn(usage, item.operation)) continue;
      usage[item.operation] += item.milliseconds;
      let uid = item.userID;
      // 旧台帳にはuserIDがないため、元の法人予約から読む。既存データは書き換えない。
      if (!uid && typeof item.reservationID === 'string' && !item.reservationID.includes('/')) {
        if (!reservations.has(item.reservationID)) {
          const reservation = await this.collection('corporateReservations').doc(item.reservationID).get();
          reservations.set(item.reservationID, reservation.exists && reservation.data().corporate?.domain === domain ? reservation.data().userID : null);
        }
        uid = reservations.get(item.reservationID);
      }
      if (uid) perUser.set(uid, (perUser.get(uid) || 0) + item.milliseconds);
    }
    const overrides = await this.collection('corporateMembers').where('domain', '==', domain).get();
    const members = new Map(overrides.docs.map(doc => [doc.data().userID, doc.data()]));
    const users = []; let token;
    do {
      const batch = await this.authProvider().listUsers(1000, token);
      for (const user of batch.users) if (emailDomain(user.email) === domain) {
        const member = members.get(user.uid) || await enrollMember(this.provider(), domain, user.uid, this.now, login.id);
        users.push({
        uid: user.uid, email: user.email, verified: !!user.emailVerified, disabled: !!user.disabled,
        enabled: member.enabled, explicit: !!member.updatedBy, used: perUser.get(user.uid) || 0,
      });
      }
      token = batch.pageToken;
    } while (token);
    users.sort((a, b) => a.email.localeCompare(b.email) || a.uid.localeCompare(b.uid));
    const filtered = users.filter(user => user.email.toLowerCase().includes(query));
    const pages = Math.max(1, Math.ceil(filtered.length / 50));
    const page = Math.min(pages, Math.max(1, Math.floor(Number(input.page) || 1)));
    const used = Object.values(usage).reduce((sum, value) => sum + value, 0), quota = quotaStatus(data, used);
    return { domain, organizationName: data.organizationName, plan: data.plan || 'custom', month, query, page, pages,
      totalAccounts: users.length, matches: filtered.length, users: filtered.slice((page - 1) * 50, page * 50),
      autoEnable: data.autoEnableMembers !== false, usage, quota, period,
      unattributed: Math.max(0, used - users.reduce((sum, user) => sum + user.used, 0)),
      estimate: estimate(data.plan || 'custom', quota.excessMilliseconds) };
  }
}
module.exports = { CorporateManagementStore, estimate };
