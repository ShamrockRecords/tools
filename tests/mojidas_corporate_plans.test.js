const assert = require('assert');
const { fixture } = require('./mojidas_corporate_billing.test');
const { schedulePlan, nextMonth, planView, applyDuePlan } = require('../modules/partners/corporate_plan_changes');
const { refreshDomain } = require('../modules/partners/domain_lifecycle');
const { CorporateUsageStore } = require('../modules/partners/corporate_usage_store');
const { PartnerStore } = require('../modules/partners/partner_store');
const { CorporateManagementStore } = require('../modules/partners/corporate_management_store');
const { HOUR, calculate } = require('../modules/billing/corporate_billing_policy');

const login = { id: 'portal-a', mustChangePassword: false };
const domain = f => f.col('corporateDomains').doc(f.row.domain);
const current = async f => (await domain(f).get()).data();
async function save(f, plan, overrides = {}, user = login) {
  return schedulePlan(f.db, f.now, user, { domain: f.row.domain, plan, month: nextMonth(f.now()),
    contract: f.id, version: String((await current(f)).planChangeVersion || 0), ...overrides });
}
async function scheduling() {
  const f = await fixture(); f.setTime('2026-10-30T12:00:00+09:00');
  const before = structuredClone(f.db.contents());
  const contractBefore = (await f.col('corporateBillingContracts').doc(f.id).get()).data();
  f.db.failCommit = true;
  await assert.rejects(save(f, 'standard'), /commit failed/);
  assert.deepStrictEqual(f.db.contents(), before, '保存失敗時は契約・予約・履歴を変更しない');
  await save(f, 'standard');
  assert.equal((await current(f)).plan, 'light');
  assert.equal((await current(f)).limitMilliseconds, 50 * HOUR);
  assert.equal((await current(f)).pendingPlanChange.plan, 'standard');
  assert.equal(planView(await current(f), f.now()).reserved, true);
  assert.deepStrictEqual((await f.col('corporateBillingContracts').doc(f.id).get()).data(),
    contractBefore);
  await save(f, 'metered'); assert.equal((await current(f)).pendingPlanChange.plan, 'metered');
  await save(f, 'light'); assert.equal((await current(f)).pendingPlanChange, null, '今月のプランで予約取消');
  assert.equal((await current(f)).plan, 'light');
  const version = String((await current(f)).planChangeVersion);
  const parallel = await Promise.allSettled([save(f, 'standard', { version }), save(f, 'metered', { version })]);
  assert.equal(parallel.filter(v => v.status === 'fulfilled').length, 1);
  assert.equal(parallel.find(v => v.status === 'rejected').reason.code, 'PLAN_CONFLICT');
  const saved = structuredClone(f.db.contents());
  for (const [input, user, code] of [
    [{ plan: 'trial' }, login, 'PLAN_INVALID'], [{ plan: 'custom' }, login, 'PLAN_INVALID'],
    [{ plan: '__proto__' }, login, 'PLAN_INVALID'], [{ plan: ['standard'] }, login, 'PLAN_INVALID'],
    [{ month: '2026-10' }, login, 'PLAN_MONTH_CHANGED'], [{ month: '2026-12' }, login, 'PLAN_MONTH_CHANGED'],
    [{ version: '0' }, login, 'PLAN_CONFLICT'], [{}, { id: 'other' }, 'PLAN_FORBIDDEN'],
    [{ contract: 'old-contract' }, login, 'PLAN_CONFLICT'],
    [{}, { ...login, mustChangePassword: true }, 'PLAN_FORBIDDEN'],
  ]) await assert.rejects(save(f, 'standard', input, user), { code });
  assert.deepStrictEqual(f.db.contents(), saved, '不正入力・権限・競合で既存予約や実績を変更しない');
  for (const patch of [{ plan: 'trial' }, { plan: 'custom' }, { partnerID: 'dealer' }, { status: 'suspended' },
    { limitMilliseconds: HOUR }, { hasValidityPeriod: true, validityStartsAt: f.row.createdAt, validityEndsAt: Date.parse('2026-11-01T00:00:00+09:00') }]) {
    await domain(f).set({ ...f.row, ...patch });
    const snapshot = structuredClone(f.db.contents());
    await assert.rejects(save(f, 'standard'), { code: 'PLAN_UNAVAILABLE' });
    assert.deepStrictEqual(f.db.contents(), snapshot);
  }
  await domain(f).set({ ...f.row, createdAt: f.now() });
  const recreated = structuredClone(f.db.contents());
  await assert.rejects(save(f, 'standard'), { code: 'PLAN_CONFLICT' });
  assert.deepStrictEqual(f.db.contents(), recreated, '再作成前の画面から新しい契約を書き換えない');
}
async function boundaryAndData() {
  const f = await fixture();
  await f.col('creditGrants').doc('personal').set({ uid: 'u', balance: 123456, expiresAt: 999999 });
  const usage = new CorporateUsageStore({ firestoreProvider: () => f.db, now: f.now });
  const corporate = { domain: f.row.domain, partnerID: 'self' };
  const args = { corporate, userID: 'member', recognitionRunID: 'cross-month', clientSessionID: 'session',
    operation: 'realtime', requestedMilliseconds: 0, trackCount: 1 };
  f.setTime('2026-10-31T23:59:59.999+09:00');
  await save(f, 'standard');
  const reservation = await usage.create(args, corporate);
  await usage.settle({ userID: 'member', reservationID: reservation.id, sequence: 1, consumedMilliseconds: HOUR }, false);
  assert.equal((await current(f)).plan, 'light');
  const oldMonth = (await f.col('corporateUsageMonths').doc('self_company.example_2026-10').get()).data();
  const ledger = structuredClone(f.db.records('Mojidas/production/corporateUsageLedger'));
  f.setTime('2026-11-01T00:00:00+09:00');
  const preApply = structuredClone(f.db.contents());
  await assert.rejects(save(f, 'metered', { month: '2026-11' }), { code: 'PLAN_MONTH_CHANGED' });
  assert.deepStrictEqual(f.db.contents(), preApply, '古い画面からの保存で予約を失わない');
  f.db.failCommit = true;
  await assert.rejects(applyDuePlan(f.db, f.row.domain, f.now()), /commit failed/);
  assert.deepStrictEqual(f.db.contents(), preApply, '適用失敗時はプラン・請求履歴とも維持');
  // スケジューラーを先に実行しなくても、月初最初の継続報告で新プランになる。
  const report = { userID: 'member', reservationID: reservation.id, sequence: 2, consumedMilliseconds: HOUR + 60000 };
  await Promise.all([usage.settle(report, false), usage.settle(report, false)]);
  assert.equal((await current(f)).plan, 'standard');
  assert.equal((await current(f)).limitMilliseconds, 100 * HOUR);
  assert.equal((await current(f)).pendingPlanChange, null);
  const status = await usage.status(corporate);
  assert.equal(status.limitMilliseconds, 100 * HOUR); assert.equal(status.usedMilliseconds, 60000);
  assert.deepStrictEqual((await f.col('corporateUsageMonths').doc('self_company.example_2026-10').get()).data(), oldMonth);
  for (const old of ledger) assert.deepStrictEqual((await f.col('corporateUsageLedger').doc(old.id).get()).data(), old.data);
  assert.deepStrictEqual((await f.col('creditGrants').doc('personal').get()).data(), { uid: 'u', balance: 123456, expiresAt: 999999 });
  const history = (await f.col('corporateBillingContracts').doc(f.id).get()).data();
  assert.equal(history.events.length, 2); assert.equal(history.events[1].at, f.now());
  assert.equal(calculate(history, '2026-10', { realtime: HOUR }).totalJPY, 13200);
  assert.equal(calculate(history, '2026-11', {}).totalJPY, 24200);
  const management = new CorporateManagementStore({ firestoreProvider: () => f.db, now: f.now,
    authProvider: () => ({ listUsers: async () => ({ users: [] }) }) });
  const october = await management.overview(login, { domain: f.row.domain, month: '2026-10' });
  assert.equal(october.plan, 'light'); assert.equal(october.quota.limitMilliseconds, 50 * HOUR);
  assert.equal(october.estimate.total, 13200, '変更後に前月を選んでも前月のプランと概算を表示');
  const closed = await f.billing.snapshot(f.id, '2026-10', true);
  await save(f, 'metered');
  await f.billing.run({ execute: true });
  const after = await f.billing.snapshot(f.id, '2026-10', true);
  for (const key of ['terms', 'lines', 'usage', 'totalJPY', 'contractDigest']) assert.deepStrictEqual(after[key], closed[key]);
  await refreshDomain(f.db, f.row.domain, f.now());
  assert.deepStrictEqual((await f.col('corporateBillingContracts').doc(f.id).get()).data(), history);
}
async function delayedAndAdministration() {
  const f = await fixture(); f.setTime('2026-10-30T12:00:00+09:00');
  await save(f, 'metered'); f.setTime('2026-12-01T03:00:00+09:00');
  const before = structuredClone(f.db.contents());
  const preview = await f.billing.run();
  assert.equal(preview.errors.length, 0);
  assert.deepStrictEqual(preview.invoices.map(i => i.totalJPY), [13200, 2200]);
  assert.deepStrictEqual(f.db.contents(), before, '予約適用が遅れた月のdry-runでも書き込まない');
  await f.billing.run({ execute: true });
  assert.equal((await current(f)).plan, 'metered');
  assert.equal((await f.col('corporateBillingContracts').doc(f.id).get()).data().events[1].at, Date.parse('2026-11-01T00:00:00+09:00'));
  const g = await fixture(); g.setTime('2026-10-30T12:00:00+09:00');
  const admin = new PartnerStore({ firestoreProvider: () => g.db, now: g.now, portalStore: null });
  await save(g, 'standard');
  await admin.updateDomain(null, { domain: g.row.domain, section: 'details', organizationName: '変更後の組織名', contactEmail: 'new@company.example', notes: '確認' });
  assert.equal((await current(g)).pendingPlanChange.plan, 'standard', '連絡先修正で予約を破棄しない');
  await admin.setDomainStatus(g.row.domain, 'inactive', 'admin@example.com');
  assert.equal((await current(g)).pendingPlanChange, null);
  g.setTime('2026-11-01T00:00:00+09:00');
  await refreshDomain(g.db, g.row.domain, g.now());
  assert.equal((await current(g)).status, 'suspended'); assert.equal((await current(g)).plan, 'light');
  const h = await fixture('standard', '2026-12-01T00:00:00+09:00');
  h.setTime('2026-12-31T23:59:59+09:00'); await save(h, 'light');
  assert.equal((await current(h)).pendingPlanChange.month, '2027-01');
  h.setTime('2027-01-01T01:00:00+09:00'); await refreshDomain(h.db, h.row.domain, h.now());
  assert.equal((await current(h)).plan, 'light');
  assert.equal((await current(h)).limitMilliseconds, 50 * HOUR);
  assert.equal(nextMonth(Date.parse('2028-02-29T23:59:59+09:00')), '2028-03');
}
async function transactionRetry() {
  const f = await fixture('metered'); f.setTime('2026-10-31T23:59:59.999+09:00');
  await save(f, 'light');
  const usage = new CorporateUsageStore({ firestoreProvider: () => f.db, now: f.now });
  const corporate = { domain: f.row.domain, partnerID: 'self' };
  const args = { corporate, userID: 'member', recognitionRunID: 'retry', clientSessionID: 'session',
    operation: 'realtime', requestedMilliseconds: 0, trackCount: 1 };
  const reservation = await usage.create(args, corporate);
  const run = f.db.runTransaction.bind(f.db); let retry = true;
  f.db.runTransaction = async fn => {
    if (retry) {
      retry = false;
      // 最初のtransactionは競合で破棄され、翌月に再実行される。
      await fn({ get: ref => ref.get(), set: () => {}, update: () => {}, delete: () => {} });
      f.setTime('2026-11-01T00:00:00+09:00');
    }
    return run(fn);
  };
  await usage.settle({ userID: 'member', reservationID: reservation.id, consumedMilliseconds: 60000 }, true);
  assert.equal((await current(f)).plan, 'light');
  assert(!(await f.col('corporateUsageMonths').doc('self_company.example_2026-10').get()).exists);
  assert.equal((await f.col('corporateUsageMonths').doc('self_company.example_2026-11').get()).data().realtime, 60000);
  assert.equal((await usage.status(corporate)).limitMilliseconds, 50 * HOUR);
}
async function main() {
  await scheduling(); await boundaryAndData(); await delayedAndAdministration(); await transactionRetry();
  console.log('法人プラン予約: 更新・取消・競合・権限・月初適用・年越し・遅延・請求・台帳/個人残高保全 成功');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
