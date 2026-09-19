const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { FakeFirestore } = require('./mojidas_credit_store.test');
const { PartnerStore } = require('../modules/partners/partner_store');
const { CorporateUsageStore } = require('../modules/partners/corporate_usage_store');
const { parseLifecycle, parseDate, refreshDomain } = require('../modules/partners/domain_lifecycle');

class DB extends FakeFirestore {
  constructor() { super(); this.queue = Promise.resolve(); }
  runTransaction(callback) {
    const task = this.queue.then(async () => {
      let writing = false; const writes = [];
      const result = await callback({
        get: ref => { assert(!writing); return ref.get(); },
        set: (ref, value) => { writing = true; writes.push(() => ref.set(value)); },
        update: (ref, value) => { writing = true; writes.push(() => ref.update(value)); },
      });
      if (this.fail) { this.fail = false; throw new Error('commit failed'); }
      for (const write of writes) await write();
      return result;
    });
    this.queue = task.catch(() => {}); return task;
  }
}
async function main() {
  const db = new DB(); let now = parseDate('2026-09-19T10:00');
  const store = new PartnerStore({ firestoreProvider: () => db, now: () => now });
  const usage = new CorporateUsageStore({ firestoreProvider: () => db, now: () => now });
  const input = { domain: 'trial.example.org', organizationName: '組織', plan: 'trial', validityPeriod: 'limited', validityStartsAt: '2026-09-20T10:00', validityEndsAt: '2026-10-20T10:00', status: 'active' };
  for (const bad of [{ plan: '__proto__' }, { validityStartsAt: '2026-02-30T10:00' }, { validityEndsAt: input.validityStartsAt }, { validityPeriod: 'invalid' }, { status: 'invalid' }]) assert.throws(() => parseLifecycle({ ...input, ...bad }));
  await store.addDomain('self', input, 'admin@example.org');
  const ref = store.collection('corporateDomains').doc(input.domain);
  const user = { email: 'member@trial.example.org', emailVerified: true };
  assert.equal(await store.entitlement(user), null);
  assert.equal((await store.dashboard('self', '2026-09'))[0].displayState, 'scheduled');
  assert.equal((await ref.get()).data().status, 'approved');
  now = parseDate(input.validityStartsAt);
  const corporate = await store.entitlement(user);
  assert.equal(corporate.partnerID, 'self');
  const args = { corporate, userID: 'user', recognitionRunID: 'run', clientSessionID: 'session', operation: 'realtime', requestedMilliseconds: 0, trackCount: 1 };
  assert.equal((await usage.selectBilling(args)).partnerID, 'self');
  const reservation = await usage.create(args, corporate);
  const before = (await ref.get()).data();
  now = parseDate(input.validityEndsAt) - 1; assert(await store.entitlement(user));
  now++;
  db.fail = true;
  await assert.rejects(store.entitlement(user), /commit failed/);
  assert.deepEqual((await ref.get()).data(), before, '保存失敗では既存データを変更しない');
  await Promise.all([store.entitlement(user), refreshDomain(db, input.domain, now)]);
  assert.equal(await store.entitlement(user), null);
  assert.deepEqual((await ref.get()).data(), { ...before, status: 'suspended', expiredAt: now });
  assert.equal((await usage.status(corporate)).usageAllowed, false);
  await ref.update({ status: 'approved' });
  assert.equal((await store.dashboard('self', '2026-10'))[0].displayState, 'inactive');
  assert.equal((await ref.get()).data().status, 'suspended', '管理画面の取得でも期限切れを永続化');
  await assert.rejects(usage.create({ ...args, recognitionRunID: 'new' }, corporate), { code: 'CORPORATE_DISABLED' });
  const report = { userID: 'user', reservationID: reservation.id, sequence: 1, consumedMilliseconds: 60000 };
  await assert.rejects(usage.settle(report, false), { code: 'CORPORATE_DISABLED' });
  await usage.settle(report, true);
  assert.equal((await store.collection('corporateReservations').doc(reservation.id).get()).data().consumedMilliseconds, 60000, '期限後の精算と再送でも利用を保持');
  await assert.rejects(store.setDomainStatus(input.domain, 'active', 'admin@example.org'));
  const oldRef = store.collection('corporateDomains').doc('old.example.org');
  const legacy = { domain: 'old.example.org', organizationName: '既存', partnerID: 'self', status: 'suspended', notes: '保持', limitMilliseconds: 3600000, approvedAt: 123 };
  await oldRef.set(legacy);
  await store.entitlement({ ...user, email: 'member@old.example.org' });
  assert.deepEqual((await oldRef.get()).data(), { ...legacy, plan: 'custom', hasValidityPeriod: false, validityStartsAt: null, validityEndsAt: null });
  await store.addDomain('self', { domain: 'off.example.org', organizationName: '無効', status: 'inactive' }, 'admin');
  assert.equal(await store.entitlement({ ...user, email: 'a@off.example.org' }), null);
  assert.equal(await store.activePartner('self'), null, '自社は販売店ログインを作らない');
  // 月途中の販売店移管。認識中の同一予約も確定報告から新販売店へ計上する。
  now = parseDate('2026-09-19T12:00');
  const dealerID = 'a'.repeat(64);
  await store.collection('partners').doc(dealerID).set({ status: 'active', name: '販売店A' });
  const transfer = { domain: 'transfer.example.org', organizationName: '移管組織', plan: 'light', validityPeriod: 'none', status: 'active', partnerID: 'self' };
  await store.addDomain('self', transfer, 'admin');
  const transferRef = store.collection('corporateDomains').doc(transfer.domain);
  const transferCorporate = { domain: transfer.domain, partnerID: 'self' };
  const moving = await usage.create({ ...args, recognitionRunID: 'moving' }, transferCorporate);
  const movingReport = { userID: 'user', reservationID: moving.id, sequence: 1, consumedMilliseconds: 60000 };
  await usage.settle(movingReport, false);
  const saved = (await transferRef.get()).data();
  db.fail = true;
  await assert.rejects(store.updateDomain(null, { ...transfer, partnerID: dealerID }), /commit failed/);
  assert.deepEqual((await transferRef.get()).data(), saved);
  assert.equal((await store.collection('corporateDomainAssignments').doc(`self_${transfer.domain}`).get()).exists, false);
  await store.updateDomain(null, { ...transfer, partnerID: dealerID, plan: 'standard' });
  await usage.settle(movingReport, false); // 移管前の報告の再送は付け替えない。
  await usage.settle({ ...movingReport, sequence: 2, consumedMilliseconds: 180000 }, true);
  assert.equal((await store.yearlyUsage('self', 2026)).find(r => r.domain === transfer.domain).months[8].total, 60000);
  assert.equal((await store.yearlyUsage(dealerID, 2026))[0].months[8].total, 120000);
  const former = (await store.dashboard('self', '2026-09')).find(r => r.domain === transfer.domain);
  assert.equal(former.historical, true); assert.equal(former.usage.realtime, 60000);
  assert.equal((await store.dashboard(dealerID, '2026-09'))[0].usage.realtime, 120000);
  await assert.rejects(store.updateDomain(dealerID, { ...transfer, plan: 'trial' }), { code: 'FORBIDDEN' });
  await assert.rejects(store.updateDomain(null, { ...transfer, validityPeriod: 'limited', validityStartsAt: 'bad' }));
  assert.equal((await transferRef.get()).data().approvedAt, saved.approvedAt);
  await store.updateDomain(null, { ...transfer, validityPeriod: 'limited', validityStartsAt: '2026-10-01T10:00', validityEndsAt: '2026-11-01T10:00' });
  assert.equal((await transferRef.get()).data().partnerID, 'self');
  assert.equal((await store.dashboard('self', '2026-09')).filter(r => r.domain === transfer.domain).length, 1, '戻したとき履歴と現在を重複表示しない');
  assert.equal(await store.entitlement({ ...user, email: 'a@transfer.example.org' }), null, '詳細で開始前へ変更');
  const context = { document: { addEventListener() {}, getElementById() { return null; } } };
  vm.createContext(context); vm.runInContext(fs.readFileSync(require.resolve('../public/javascripts/mojidas-partners.js'), 'utf8'), context);
  assert.equal(context.nextValidityMonth('2026-01-31T10:30'), '2026-02-28T10:30');
  assert.equal(context.nextValidityMonth('2028-01-31T10:30'), '2028-02-29T10:30');
  assert.equal(context.nextValidityMonth('2026-12-19T10:30'), '2027-01-19T10:30');
  const fieldset = {}, form = { elements: { validityPeriod: { value: 'limited' }, validityStartsAt: { value: '' }, validityEndsAt: { value: '' } }, querySelector: () => fieldset };
  context.updateValidity(form);
  assert.equal(form.elements.validityEndsAt.value, context.nextValidityMonth(form.elements.validityStartsAt.value));
  assert.equal(fieldset.disabled, false);
  form.elements.validityPeriod.value = 'none'; context.updateValidity(form); assert.equal(fieldset.disabled, true);
  console.log('法人期間: 自社・開始前・境界・期限切れ永続化・既存補完・失敗再送・精算保全・月末補正 成功');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
