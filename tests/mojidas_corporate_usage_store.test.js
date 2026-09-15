const assert = require('assert');
const { FakeFirestore } = require('./mojidas_credit_store.test');
const { MojidasCreditStore } = require('../modules/credit/mojidas_credit_store');
const { mojidasCollectionPath } = require('../modules/mojidas_firestore');
const { CorporateUsageStore, withCorporateUsage } = require('../modules/partners/corporate_usage_store');

// 失敗時は書き込みを破棄し、同時リクエストは直列化。実Firestore試験とは区別する。
class TransactionDB extends FakeFirestore {
  constructor() { super(); this.pending = Promise.resolve(); this.failCommit = false; }
  runTransaction(callback) {
    const task = this.pending.then(async () => {
      const writes = []; let writing = false;
      const result = await callback({
        get: ref => { assert(!writing, 'Firestoreは書き込み後の読み取り不可'); return ref.get(); },
        set: (...args) => { writing = true; writes.push(() => args[0].set(...args.slice(1))); },
        update: (...args) => { writing = true; writes.push(() => args[0].update(...args.slice(1))); },
        delete: ref => { writing = true; writes.push(() => ref.delete()); },
      });
      if (this.failCommit) { this.failCommit = false; throw new Error('commit failed'); }
      for (const write of writes) await write();
      return result;
    });
    this.pending = task.catch(() => {}); return task;
  }
}
async function main() {
  const db = new TransactionDB(); let clock = Date.UTC(2026, 8, 15);
  const options = { firestoreProvider: () => db, now: () => clock };
  const base = new MojidasCreditStore(options), corporateStore = new CorporateUsageStore(options);
  let store = withCorporateUsage(base, corporateStore);
  const scope = { domain: 'example.co.jp', partnerID: 'dealer' };
  const collection = name => db.collection(mojidasCollectionPath(name));
  await collection('partners').doc('dealer').set({ status: 'active' });
  await collection('corporateDomains').doc(scope.domain).set({ status: 'approved', partnerID: 'dealer' });
  const args = { userID: 'member', accountCreatedAt: new Date(clock), operation: 'realtime',
    clientSessionID: 'session', recognitionRunID: 'first', requestedMilliseconds: 0, trackCount: 1 };
  await base.getBalance(args);
  const personal = await store.createReservation(args);
  await store.heartbeat({ reservationID: personal.id, ...args, corporate: scope, sequence: 1, consumedMilliseconds: 2000 });
  const grantsBefore = JSON.stringify(db.records(mojidasCollectionPath('creditGrants')));
  const oldRetry = await store.createReservation({ ...args, corporate: scope });
  assert.equal(oldRetry.id, personal.id);
  const corpArgs = { ...args, recognitionRunID: 'second', corporate: scope };
  const [a, b] = await Promise.all([store.createReservation(corpArgs), store.createReservation(corpArgs)]);
  assert.equal(a.id, b.id); assert(a.isCorporate);
  const expiry = a.leaseExpiresAt;
  await collection('corporateReservations').doc(a.id).update({ leaseExpiresAt: { toDate: () => expiry } });
  const restored = await store.createReservation(corpArgs);
  assert(restored.leaseExpiresAt instanceof Date, 'Firestore Timestampも既存APIと同じISO8601形式');
  const report = { reservationID: a.id, userID: args.userID, clientRequest: true, sequence: 1, consumedMilliseconds: 60000 };
  await Promise.all([store.heartbeat(report), store.heartbeat(report)]);
  let usage = db.records(mojidasCollectionPath('corporateUsageMonths'));
  assert.equal(usage[0].data.realtime, 60000);
  assert.equal(JSON.stringify(db.records(mojidasCollectionPath('creditGrants'))), grantsBefore);
  await assert.rejects(store.heartbeat({ ...report, userID: 'other' }), { code: 'RESERVATION_NOT_FOUND' });
  db.failCommit = true;
  await assert.rejects(store.heartbeat({ ...report, sequence: 2, consumedMilliseconds: 70000 }), /commit failed/);
  assert.equal(db.records(mojidasCollectionPath('corporateUsageMonths'))[0].data.realtime, 60000);
  await collection('corporateDomains').doc(scope.domain).update({ status: 'suspended' });
  // 解除後も開始済みの法人認識は法人で精算。再起動しても同じ区分。
  store = withCorporateUsage(base, new CorporateUsageStore(options));
  await store.heartbeat({ ...report, sequence: 2, consumedMilliseconds: 70000 });
  await store.completeReservation({ ...report, consumedMilliseconds: 80000 });
  await store.completeReservation({ ...report, consumedMilliseconds: 90000 });
  assert.equal(db.records(mojidasCollectionPath('corporateUsageMonths'))[0].data.realtime, 80000);
  assert.equal(JSON.stringify(db.records(mojidasCollectionPath('creditGrants'))), grantsBefore);
  const after = await store.createReservation({ ...args, recognitionRunID: 'third' });
  assert(!after.isCorporate);
  await assert.rejects(store.createReservation({ ...corpArgs, recognitionRunID: 'invalid-new' }), { code: 'CORPORATE_DISABLED' });
  await collection('corporateDomains').doc(scope.domain).update({ status: 'approved' });
  for (const [run, consumed] of [['file-success', 3000], ['file-error', 0], ['file-stop', 10000]]) {
    const file = await store.createReservation({ ...corpArgs, operation: 'mediaFile', recognitionRunID: run, requestedMilliseconds: 10000 });
    await store.completeReservation({ reservationID: file.id, userID: args.userID, consumedMilliseconds: consumed,
      cancelled: run !== 'file-success', clientRequest: true });
  }
  const translation = await store.createReservation({ ...corpArgs, operation: 'formalTranslation', recognitionRunID: 'translation', requestedMilliseconds: 5000 });
  await assert.rejects(store.completeReservation({ reservationID: translation.id, userID: args.userID,
    consumedMilliseconds: 5000, clientRequest: true }), { code: 'RESERVATION_SERVER_MANAGED' });
  await store.completeReservation({ reservationID: translation.id, userID: args.userID, consumedMilliseconds: 5000 });
  usage = db.records(mojidasCollectionPath('corporateUsageMonths'))[0].data;
  assert.equal(usage.mediaFile, 13000); assert.equal(usage.formalTranslation, 5000);
  const balance = await store.getBalance(corpArgs);
  assert(balance.isCorporate && balance.isUnlimited);
  clock = Date.UTC(2026, 9, 16);
  await store.getBalance(corpArgs);
  assert.equal(db.records(mojidasCollectionPath('creditGrants')).filter(row => row.data.type === 'monthlyFree').length, 2);
  console.log('法人ストア: 個人残高保全・区分固定・同時再送・失敗再試行・再読込・解除・ファイル・翻訳・無料枠更新の隔離テスト成功');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
