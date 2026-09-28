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
  assert.equal(periodAt(Date.UTC(2026, 2, 15), { resetDay: 31 }).end, Date.UTC(2026, 2, 31, 15));
  assert.equal(parseQuota({ resetDay: '17', limitHours: '10' }).resetDay, 1);
  assert.throws(() => parseQuota({ resetDay: '1', limitHours: '-1' }));
  assert.equal(parseQuota({ resetDay: '31', limitHours: '' }).limitMilliseconds, null);
  const db = new DB(); let now = Date.UTC(2026, 8, 17), deliveries = [], failMail = true;
  const options = { firestoreProvider: () => db, now: () => now, mailer: { send: async mail => {
    if (mail.to === 'dealer@example.net' && failMail) { failMail = false; throw new Error('mail failed'); }
    deliveries.push(mail.to);
  } } };
  const store = new CorporateUsageStore(options), partners = new PartnerStore({ ...options, portalStore: null });
  const col = name => db.collection(mojidasCollectionPath(name));
  const corporate = { domain: 'example.org', partnerID: 'dealer' };
  const domain = col('corporateDomains').doc(corporate.domain);
  await col('partners').doc('dealer').set({ status: 'active', email: 'dealer@example.net' });
  await domain.set({ ...corporate, organizationName: '組織', status: 'approved', approvedAt: now,
    resetDay: 17, limitMilliseconds: 7200000, stopAtLimit: true, notifyAtOneHour: true, contactEmail: 'contact@example.org' });
  const args = { corporate, userID: 'user', recognitionRunID: 'run', clientSessionID: 'session',
    operation: 'realtime', requestedMilliseconds: 0, trackCount: 1 };
  const reservation = await store.create(args, corporate);
  assert.equal((await store.status(corporate)).remainingMilliseconds, 7200000, '月途中の開始でも上限を日割りしない');
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
  now = boundary(2026, 9, 1) - 1;
  assert.equal((await store.status(corporate)).usedMilliseconds, 7201000, '月末まで利用量を保持する');
  now += 1;
  assert.equal((await store.status(corporate)).usedMilliseconds, 0, '日本時間1日0時で新期間');
  assert.equal((await store.status(corporate)).remainingMilliseconds, 10800000, '翌月も上限を満額付与する');
  assert.equal((await store.status(corporate)).usageAllowed, true);
  assert.equal(db.records(mojidasCollectionPath('creditGrants')).length, 0, '個人残高を操作しない');
  // 旧リセット日のキャッシュではなく、暦月の台帳から移行する。
  const migratedDomain = 'migration.example.org';
  await col('corporateDomains').doc(migratedDomain).set({ partnerID: 'dealer', status: 'approved', resetDay: 17, limitMilliseconds: 7200000 });
  await col('corporateQuotaPeriods').doc(`${migratedDomain}_2026-09-17_17_0`).set({ usage: { realtime: 99999999, mediaFile: 0, formalTranslation: 0 } });
  await col('corporateUsageLedger').doc('migration-ledger').set({ domain: migratedDomain, operation: 'realtime', milliseconds: 1234, occurredAt: new Date(Date.UTC(2026, 8, 3)) });
  now = Date.UTC(2026, 8, 20);
  assert.equal((await store.status({ domain: migratedDomain, partnerID: 'dealer' })).usedMilliseconds, 1234);
  assert.equal((await store.status({ domain: migratedDomain, partnerID: 'dealer' })).usedMilliseconds, 1234, '再読込で二重計上しない');
  assert.equal((await col('corporateUsageLedger').doc('migration-ledger').get()).data().milliseconds, 1234, '旧台帳は変更しない');
  const switching = 'switch.example.org', HOUR = 3600000;
  const switchRef = col('corporateDomains').doc(switching);
  await switchRef.set({ domain: switching, partnerID: 'self', organizationName: '切替テスト', status: 'approved',
    plan: 'trial', hasValidityPeriod: true, validityStartsAt: Date.parse('2026-08-15T00:00:00+09:00'),
    validityEndsAt: Date.parse('2026-10-15T00:00:00+09:00'), limitMilliseconds: 10 * HOUR });
  for (const [id, date, hours] of [['aug', '2026-08-20', 6], ['sep', '2026-09-10', 4]])
    await col('corporateUsageLedger').doc(id).set({ domain: switching, partnerID: 'self', operation: 'realtime', milliseconds: hours * HOUR, occurredAt: new Date(date) });
  const target = { domain: switching, partnerID: 'self' };
  assert.equal((await store.status(target)).usedMilliseconds, 10 * HOUR, 'トライアルは月またぎで合算');
  const change = plan => partners.updateDomain(null, { domain: switching, section: 'plan', plan, validityPeriod: 'none', limitHours: '999' });
  await change('light');
  assert.equal((await store.status(target)).usedMilliseconds, 4 * HOUR, '月額切替時は当月のトライアル利用も含める');
  assert.equal((await store.status(target)).remainingMilliseconds, 46 * HOUR);
  await col('corporateUsageLedger').doc('sep-extra').set({ domain: switching, partnerID: 'self', operation: 'realtime', milliseconds: 56 * HOUR, occurredAt: new Date('2026-09-18') });
  await change('standard');
  assert.equal((await store.status(target)).remainingMilliseconds, 40 * HOUR);
  await change('light');
  assert.equal((await store.status(target)).excessMilliseconds, 10 * HOUR, 'ライトへ戻す場合も古いキャッシュを使わない');
  await change('metered');
  assert.equal((await store.status(target)).excessMilliseconds, 60 * HOUR);
  await change('custom');
  assert.equal((await store.status(target)).limitMilliseconds, null);
  const preserved = (await switchRef.get()).data();
  db.fail = true;
  await assert.rejects(change('standard'), /commit failed/);
  assert.deepStrictEqual((await switchRef.get()).data(), preserved, '保存失敗ではプランと上限を保持');
  assert.equal((await col('corporateUsageLedger').doc('aug').get()).data().milliseconds, 6 * HOUR, '過去の台帳は消さない');
  console.log('法人上限: 月末・閏年・再送・失敗・超過・通知再試行・設定変更・リセット・個人残高保全 成功');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
