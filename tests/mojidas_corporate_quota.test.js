const assert = require('assert');
const { FakeFirestore } = require('./mojidas_credit_store.test');
const { mojidasCollectionPath } = require('../modules/mojidas_firestore');
const { CorporateUsageStore } = require('../modules/partners/corporate_usage_store');
const { PartnerStore } = require('../modules/partners/partner_store');
const { periodAt, boundary, parseQuota } = require('../modules/partners/quota_policy');

// 実サービスへは接続せず、transaction失敗時の書き込み破棄と並行再送を再現する。
class DB extends FakeFirestore {
  constructor() { super(); this.pending = Promise.resolve(); this.fail = false; }
  runTransaction(callback) {
    const task = this.pending.then(async () => {
      const writes = []; let writing = false;
      const result = await callback({
        get: ref => { assert(!writing); return ref.get(); },
        set: (ref, ...args) => { writing = true; writes.push(() => ref.set(...args)); },
        update: (ref, ...args) => { writing = true; writes.push(() => ref.update(...args)); },
      });
      if (this.fail) { this.fail = false; throw new Error('commit failed'); }
      for (const write of writes) await write();
      return result;
    });
    this.pending = task.catch(() => {}); return task;
  }
}
async function main() {
  assert.equal(boundary(2028, 1, 31), Date.UTC(2028, 1, 28, 15));
  assert.equal(boundary(2026, 1, 31), Date.UTC(2026, 1, 27, 15));
  assert.equal(periodAt(Date.UTC(2026, 2, 15), { resetDay: 31 }).end, Date.UTC(2026, 2, 30, 15));
  assert.throws(() => parseQuota({ resetDay: '0', limitHours: '10' }));
  assert.throws(() => parseQuota({ resetDay: '1', limitHours: '-1' }));
  assert.equal(parseQuota({ resetDay: '31', limitHours: '' }).limitMilliseconds, null);
  const db = new DB(); let now = Date.UTC(2026, 8, 17), deliveries = [], failMail = true;
  const options = { firestoreProvider: () => db, now: () => now, mailer: { send: async mail => {
    if (mail.to === 'dealer@example.net' && failMail) { failMail = false; throw new Error('mail failed'); }
    deliveries.push(mail.to);
  } } };
  const store = new CorporateUsageStore(options), partners = new PartnerStore(options);
  const col = name => db.collection(mojidasCollectionPath(name));
  const corporate = { domain: 'example.org', partnerID: 'dealer' };
  const domain = col('corporateDomains').doc(corporate.domain);
  await col('partners').doc('dealer').set({ status: 'active', email: 'dealer@example.net' });
  await domain.set({ ...corporate, organizationName: '組織', status: 'approved', approvedAt: now,
    resetDay: 17, limitMilliseconds: 7200000, stopAtLimit: true, notifyAtOneHour: true, contactEmail: 'contact@example.org' });
  const args = { corporate, userID: 'user', recognitionRunID: 'run', clientSessionID: 'session',
    operation: 'realtime', requestedMilliseconds: 0, trackCount: 1 };
  const reservation = await store.create(args, corporate);
  const report = { userID: 'user', reservationID: reservation.id, sequence: 1, consumedMilliseconds: 3600000 };
  await Promise.all([store.settle(report, false), store.settle(report, false)]);
  await store.settle(report, false); // 配送失敗した宛先だけ次の報告で再試行する。
  assert.deepEqual(deliveries.sort(), ['contact@example.org', 'dealer@example.net']);
  assert.equal((await store.status(corporate)).usedMilliseconds, 3600000);
  db.fail = true;
  await assert.rejects(store.settle({ ...report, sequence: 2, consumedMilliseconds: 7200000 }, false), /commit failed/);
  assert.equal((await store.status(corporate)).usedMilliseconds, 3600000);
  await assert.rejects(store.settle({ ...report, sequence: 2, consumedMilliseconds: 7200000 }, false), { code: 'CORPORATE_LIMIT_REACHED' });
  await assert.rejects(store.settle({ ...report, sequence: 2, consumedMilliseconds: 7200000 }, false), { code: 'CORPORATE_LIMIT_REACHED' });
  assert.equal((await store.status(corporate)).usedMilliseconds, 7200000);
  await assert.rejects(store.create({ ...args, recognitionRunID: 'blocked' }, corporate), { code: 'CORPORATE_LIMIT_REACHED' });
  await assert.rejects(store.assertActive({ reservationID: reservation.id, userID: 'user' }), { code: 'CORPORATE_LIMIT_REACHED' });
  await store.settle({ ...report, consumedMilliseconds: 7201000 }, true);
  await store.settle({ ...report, consumedMilliseconds: 7202000 }, true);
  assert.equal((await store.status(corporate)).excessMilliseconds, 1000);
  assert.equal(deliveries.length, 2);
  await domain.update({ stopAtLimit: false });
  assert.equal((await store.status(corporate)).usageAllowed, true);
  await store.create({ ...args, recognitionRunID: 'allowed' }, corporate);
  const before = JSON.stringify(db.records(mojidasCollectionPath('corporateUsageLedger')));
  await partners.updateDomain('dealer', { domain: corporate.domain, organizationName: '組織', contactEmail: 'contact@example.org',
    notes: '', limitHours: '3', resetDay: '16', stopAtLimit: 'on', notifyAtOneHour: 'on' });
  assert.equal((await store.status(corporate)).usedMilliseconds, 7201000, '設定変更でも既存台帳から再集計');
  assert.equal(JSON.stringify(db.records(mojidasCollectionPath('corporateUsageLedger'))), before);
  now = boundary(2026, 9, 16);
  assert.equal((await store.status(corporate)).usedMilliseconds, 0, '指定日0時で自動的に新期間');
  assert.equal((await store.status(corporate)).usageAllowed, true);
  assert.equal(db.records(mojidasCollectionPath('creditGrants')).length, 0, '個人残高を操作しない');
  console.log('法人上限: 月末・閏年・再送・失敗・超過・通知再試行・設定変更・リセット・個人残高保全 成功');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
