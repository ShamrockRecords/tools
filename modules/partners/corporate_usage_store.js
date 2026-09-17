const crypto = require('crypto');
const { getFirestore } = require('../firestore');
const { mojidasCollection } = require('../mojidas_firestore');
const { nextUsage, monthAt } = require('./usage_policy');
const { UNLIMITED_AVAILABLE_MILLISECONDS } = require('../credit/mojidas_credit_store');
const { quotaStatus } = require('./quota_policy');
const { readQuota, saveQuota, totalUsage, notifyQuota } = require('./quota_store');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const runID = (uid, run) => crypto.createHash('sha256').update(`${uid}:${run}`).digest('hex').slice(0, 32);
const lease = (row, now) => new Date(now + Math.max(600000, row.operation === 'mediaFile' ? row.requestedMilliseconds + 1800000 : 600000));
const present = (id, row) => ({ id, isUnlimited: true, isCorporate: true,
  requestedMilliseconds: row.requestedMilliseconds, consumedMilliseconds: row.consumedMilliseconds,
  leaseExpiresAt: row.leaseExpiresAt?.toDate ? row.leaseExpiresAt.toDate() : row.leaseExpiresAt, status: row.status });

// 個人の予約・台帳・grantは更新しない。法人専用collectionに隔離する。
class CorporateUsageStore {
  constructor({ firestoreProvider = getFirestore, now = Date.now, mailer } = {}) {
    this.provider = firestoreProvider; this.now = now; this.mailer = mailer;
  }
  collection(name) { return mojidasCollection(this.provider(), name); }
  async status(corporate) {
    const result = await this.provider().runTransaction(async tx => {
      const snapshot = await tx.get(this.collection('corporateDomains').doc(corporate.domain));
      const row = snapshot.exists ? snapshot.data() : {};
      const quota = await readQuota(this.provider(), tx, corporate.domain, row, this.now());
      if (quota.missing) saveQuota(tx, quota);
      return { row, quota, status: quotaStatus(row, totalUsage(quota.usage)) };
    });
    if (result.quota) await this.notify(corporate.domain, result.row, result.quota);
    return result.status;
  }
  async notify(domain, row, quota) {
    try { await notifyQuota(this.provider(), domain, row, quota, this.now(), this.mailer); }
    catch (error) { console.warn('[Mojidas] 法人通知の処理失敗', error.code || 'NOTIFICATION_FAILED'); }
  }
  async selectBilling(args) {
    const id = runID(args.userID, args.recognitionRunID);
    return this.provider().runTransaction(async tx => {
      const ref = this.collection('billingRunKinds').doc(id), previous = await tx.get(ref);
      if (previous.exists) {
        const row = previous.data();
        if (row.operation !== args.operation || row.clientSessionID !== args.clientSessionID)
          fail('IDEMPOTENCY_CONFLICT');
        return row.corporate;
      }
      // 旧クライアントが開始済みの個人予約は、承認後でも法人へ付け替えない。
      const personal = await tx.get(this.collection('creditReservations').doc(`reservation_${id}`));
      let corporate = personal.exists ? null : args.corporate || null;
      if (corporate) {
        const domain = await tx.get(this.collection('corporateDomains').doc(corporate.domain));
        const partner = await tx.get(this.collection('partners').doc(corporate.partnerID));
        if (!domain.exists || domain.data().status !== 'approved' || domain.data().partnerID !== corporate.partnerID
            || !partner.exists || partner.data().status !== 'active') fail('CORPORATE_DISABLED');
      }
      tx.set(ref, { userID: args.userID, corporate, operation: args.operation, clientSessionID: args.clientSessionID, createdAt: new Date(this.now()) });
      return corporate;
    });
  }
  async create(args, corporate) {
    const id = `corporate_${runID(args.userID, args.recognitionRunID)}`;
    return this.provider().runTransaction(async tx => {
      const ref = this.collection('corporateReservations').doc(id), snapshot = await tx.get(ref);
      if (snapshot.exists) {
        const row = snapshot.data();
        if (row.userID !== args.userID || row.operation !== args.operation || row.clientSessionID !== args.clientSessionID
            || row.requestedMilliseconds !== args.requestedMilliseconds) fail('IDEMPOTENCY_CONFLICT');
        if (!['held', 'consuming'].includes(row.status)) fail('RESERVATION_CLOSED');
        return { ...present(id, row), alreadyReserved: true };
      }
      const domain = await tx.get(this.collection('corporateDomains').doc(corporate.domain));
      const settings = domain.exists ? domain.data() : {};
      if (settings.limitMilliseconds != null) {
        const quota = await readQuota(this.provider(), tx, corporate.domain, settings, this.now());
        if (!quotaStatus(settings, totalUsage(quota.usage)).usageAllowed) fail('CORPORATE_LIMIT_REACHED');
        if (quota.missing) saveQuota(tx, quota);
      }
      const row = { userID: args.userID, corporate, operation: args.operation, clientSessionID: args.clientSessionID,
        recognitionRunID: args.recognitionRunID, requestedMilliseconds: args.requestedMilliseconds,
        consumedMilliseconds: 0, sequence: 0, status: args.operation === 'realtime' ? 'consuming' : 'held',
        trackCount: args.trackCount, createdAt: new Date(this.now()) };
      row.leaseExpiresAt = lease(row, this.now());
      tx.set(ref, row); return present(id, row);
    });
  }
  async settle(args, finish) {
    const outcome = await this.provider().runTransaction(async tx => {
      const ref = this.collection('corporateReservations').doc(args.reservationID), snapshot = await tx.get(ref);
      if (!snapshot.exists) fail('RESERVATION_NOT_FOUND');
      const result = nextUsage(snapshot.data(), { ...args, finish });
      const row = result.row, month = monthAt(this.now());
      const domain = await tx.get(this.collection('corporateDomains').doc(row.corporate.domain));
      const settings = domain.exists ? domain.data() : {};
      const quota = await readQuota(this.provider(), tx, row.corporate.domain, settings, this.now());
      const statsRef = this.collection('corporateUsageMonths').doc(`${row.corporate.partnerID}_${row.corporate.domain}_${month}`);
      const stats = result.delta > 0 ? await tx.get(statsRef) : null;
      const updated = { ...row, leaseExpiresAt: lease(row, this.now()), updatedAt: new Date(this.now()) };
      if (result.changed) tx.set(ref, updated);
      if (quota) {
        quota.usage[row.operation] += result.delta;
        saveQuota(tx, quota);
      }
      if (result.delta > 0) {
        const old = stats.exists ? stats.data() : {};
        const total = (old[row.operation] || 0) + result.delta;
        if (!Number.isSafeInteger(total)) fail('INVALID_USAGE');
        tx.set(statsRef, { ...old, domain: row.corporate.domain, partnerID: row.corporate.partnerID,
          month, [row.operation]: total });
        tx.set(this.collection('corporateUsageLedger').doc(`${ref.id}_${row.consumedMilliseconds}`), {
          reservationID: ref.id, domain: row.corporate.domain, partnerID: row.corporate.partnerID,
          operation: row.operation, month, milliseconds: result.delta, occurredAt: new Date(this.now()),
        });
      }
      return { reservation: present(ref.id, result.changed ? updated : row), settings, quota, domain: row.corporate.domain };
    });
    if (outcome.quota) {
      await this.notify(outcome.domain, outcome.settings, outcome.quota);
      // 利用確定を先にcommitする。エラーで台帳を巻き戻さず、終了時の精算も許可する。
      if (!finish && !quotaStatus(outcome.settings, totalUsage(outcome.quota.usage)).usageAllowed)
        fail('CORPORATE_LIMIT_REACHED');
    }
    return outcome.reservation;
  }
  async assertActive(args) {
    const snapshot = await this.collection('corporateReservations').doc(args.reservationID).get();
    if (!snapshot.exists || snapshot.data().userID !== args.userID) fail('RESERVATION_NOT_FOUND');
    const row = snapshot.data(), expiry = row.leaseExpiresAt;
    if (!['held', 'consuming'].includes(row.status)
        || new Date(expiry.toDate ? expiry.toDate() : expiry).getTime() <= this.now()) fail('RESERVATION_EXPIRED');
    if (!(await this.status(row.corporate)).usageAllowed) fail('CORPORATE_LIMIT_REACHED');
    return row;
  }
}

function withCorporateUsage(base, store = new CorporateUsageStore()) {
  return new Proxy(base, { get(target, name) {
    if (name === 'getBalance') return async args => {
      // 法人利用中も無料枠の期限更新は従来どおり。購入分は消費しない。
      const balance = await target.getBalance(args);
      // 旧アプリも数値残高で開始可否を判定する。従来の無制限レスポンスと同じ上限値を返す。
      // 個人grantの保存値・購入残高は変更しない。
      if (!args.corporate) return { ...balance, isCorporate: false };
      const status = await store.status(args.corporate);
      return { ...balance, ...status, availableMilliseconds: status.usageAllowed ? UNLIMITED_AVAILABLE_MILLISECONDS : 0,
        isUnlimited: status.usageAllowed, isCorporate: true };
    };
    if (name === 'createReservation') return async args => {
      const corporate = await store.selectBilling(args);
      return corporate ? store.create(args, corporate) : target.createReservation(args);
    };
    if (name === 'heartbeat' || name === 'completeReservation' || name === 'assertActiveReservation')
      return args => String(args.reservationID).startsWith('corporate_')
        ? name === 'assertActiveReservation' ? store.assertActive(args) : store.settle(args, name === 'completeReservation')
        : target[name](args);
    const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
  } });
}
module.exports = { CorporateUsageStore, withCorporateUsage, runID };
