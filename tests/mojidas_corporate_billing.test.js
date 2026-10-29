const assert = require('assert');
const { FakeFirestore } = require('./mojidas_credit_store.test');
const { CorporateBillingService } = require('../modules/billing/corporate_billing_service');
const { prepareContractChange } = require('../modules/billing/corporate_billing_contracts');
const { price, period, monthsUntil, calculate, contractID, terms, HOUR } = require('../modules/billing/corporate_billing_policy');
const { PartnerStore } = require('../modules/partners/partner_store');
const { CorporateUsageStore } = require('../modules/partners/corporate_usage_store');
const { CorporateManagementStore } = require('../modules/partners/corporate_management_store');
const { MojidasStripeBillingService } = require('../modules/billing/mojidas_stripe_billing');
const { main: cli, options } = require('../scripts/bill_mojidas_corporate');

class DB extends FakeFirestore {
  constructor() { super(); this.queue = Promise.resolve(); }
  contents() { return new Map([...this.collections].filter(([, docs]) => docs.size)); }
  runTransaction(fn) {
    const task = this.queue.then(async () => {
      let writing = false; const writes = [];
      const result = await fn({
        get: ref => { assert(!writing, 'Firestoreの全readはwriteより前'); return ref.get(); },
        set: (ref, ...args) => { writing = true; writes.push(() => ref.set(...args)); },
        update: (ref, ...args) => { writing = true; writes.push(() => ref.update(...args)); },
        delete: ref => { writing = true; writes.push(() => ref.delete()); },
      });
      if (this.failCommit) { this.failCommit = false; throw Error('commit failed'); }
      for (const write of writes) await write();
      return result;
    });
    this.queue = task.catch(() => {}); return task;
  }
}
class StripeFixture {
  constructor(now) {
    this.now = now; this.cache = new Map(); this.calls = []; this.records = new Map(); this.customersByID = new Map(); this.sentEvents = [];
    this.customers = { create: (p, opts) => this.call('customer', p, opts, () => {
      const c = { id: `cus_${this.customersByID.size + 1}`, ...p }; this.customersByID.set(c.id, c); return c;
    }), list: async p => ({ data: [...this.customersByID.values()].filter(c => c.email === p.email), has_more: false }) };
    this.invoices = {
      create: (p, opts) => this.call('invoice', p, opts, () => {
        const i = { ...p, id: `in_${this.records.size + 1}`, object: 'invoice', status: 'draft', total: 0,
          lines: { data: [] }, status_transitions: {}, number: null, hosted_invoice_url: null, invoice_pdf: null };
        this.records.set(i.id, i); return i;
      }),
      retrieve: async id => { assert(this.records.has(id)); return structuredClone(this.records.get(id)); },
      list: async p => ({ data: [...this.records.values()].filter(i => i.customer === p.customer), has_more: false }),
      finalizeInvoice: (id, p, opts) => this.call('finalize', { id, ...p }, opts, () => {
        const i = this.records.get(id); i.status = 'open'; i.number = `TEST-${id}`;
        i.status_transitions.finalized_at = Math.floor(this.now() / 1000);
        i.hosted_invoice_url = `https://invoice.stripe.com/i/${id}`; i.invoice_pdf = `https://pay.stripe.com/invoice/${id}/pdf`;
        return i;
      }),
      sendInvoice: (id, p, opts) => this.call('mail', { id, ...p }, opts, () => {
        this.sentEvents.push({ id: `evt_${this.sentEvents.length}`, data: { object: { id } }, request: { idempotency_key: opts.idempotencyKey } });
        return this.records.get(id);
      }),
    };
    this.invoiceItems = { create: (p, opts) => this.call('line', p, opts, () => {
      const i = this.records.get(p.invoice); assert.equal(i.status, 'draft');
      const item = { ...p, id: `ii_${i.lines.data.length + 1}` }; i.lines.data.push(item); i.total += p.amount; return item;
    }), list: async p => ({ data: this.records.get(p.invoice).lines.data, has_more: false }) };
    this.events = { list: async () => ({ data: this.sentEvents, has_more: false }) };
    this.taxRates = { retrieve: async () => ({ active: true, inclusive: true, percentage: 10 }) };
  }
  async call(kind, params, opts, create) {
    assert(opts.idempotencyKey);
    const key = opts.idempotencyKey, old = this.cache.get(key);
    if (old) { assert.deepStrictEqual(old.params, params); return structuredClone(old.value); }
    const value = structuredClone(create());
    this.calls.push({ kind, params }); this.cache.set(key, { params: structuredClone(params), value });
    if (this.loseResponse === kind) { this.loseResponse = null; throw Object.assign(Error('connection lost after success'), { code: 'NETWORK_ERROR' }); }
    return value;
  }
  count(kind) { return this.calls.filter(c => c.kind === kind).length; }
}
async function fixture(plan = 'light', at = '2026-10-01T00:00:00+09:00') {
  const db = new DB(); let clock = Date.parse(at);
  const now = () => clock, stripe = new StripeFixture(now), billing = new CorporateBillingService({
    firestoreProvider: () => db, now, stripeClient: stripe, environment: {},
  });
  const row = { domain: 'company.example', partnerID: 'self', status: 'approved', plan,
    organizationName: 'テスト法人', contactEmail: 'billing@company.example', portalAccountID: 'portal-a',
    createdAt: clock, limitMilliseconds: (plan === 'light' ? 50 : plan === 'standard' ? 100 : 0) * HOUR };
  await billing.collection('corporateDomains').doc(row.domain).set(row);
  await db.runTransaction(async tx => {
    const write = await prepareContractChange(db, tx, row, clock, { fromCreation: true }); write(row);
  });
  return { db, stripe, billing, row, now, setTime: value => { clock = typeof value === 'number' ? value : Date.parse(value); },
    col: name => billing.collection(name), id: contractID(row) };
}
async function policyChecks() {
  assert.equal(period('2028-02').days, 29);
  assert.equal(period('2026-02').days, 28);
  assert.equal(period('2026-10').start, Date.parse('2026-10-01T00:00:00+09:00'));
  assert.deepStrictEqual(monthsUntil('2026-10', Date.parse('2026-11-01T00:00:00+09:00')), ['2026-10']);
  assert.deepStrictEqual(monthsUntil('2026-10', Date.parse('2026-10-31T23:59:59+09:00')), []);
  assert.equal(price('light', 15, 30, 25 * HOUR).totalJPY, 6600);
  assert.equal(price('standard', 15, 30, 50 * HOUR).totalJPY, 12100);
  assert.equal(price('metered', 15, 30, 0).totalJPY, 1100);
  assert.equal(price('light', 15, 30, 25 * HOUR + 70000).totalJPY, 6611);
  assert.equal(price('light', 15, 30, 25 * HOUR + 1).totalJPY, 6605);
  // 端数を明細単位で捨てる旧方式なら失敗する値。
  const fractional = price('light', 1, 31, 0);
  assert.equal(fractional.totalJPY, 425);
  assert.equal(fractional.lines.reduce((s, l) => s + l.amount, 0), 425);
  assert.equal(fractional.lines.find(l => l.key === 'rounding').amount, 1);
  const inc = 50 * HOUR / 31;
  assert.equal(price('light', 1, 31, Math.floor(inc)).billableMinutes, 0);
  assert.equal(price('light', 1, 31, Math.floor(inc) + 1).billableMinutes, 1);
  assert.throws(() => price('light', 0, 31, 0));
  assert.throws(() => price('light', 31, 31, -1));
  assert.throws(() => period('2026-13'));
  assert.throws(() => period('1999-01'));
}
async function pipelineChecks() {
  const f = await fixture();
  const { billing, stripe, col, db, row, id } = f;
  const personal = { userID: 'member', remainingMilliseconds: 123456 };
  await col('creditGrants').doc('personal').set(personal);
  await col('corporateUsageMonths').doc('self_company.example_2026-10').set({
    domain: row.domain, partnerID: 'self', month: '2026-10', realtime: 50 * HOUR, mediaFile: 70000, formalTranslation: 0,
  });
  await col('corporateUsageLedger').doc('real-usage').set({ domain: row.domain, milliseconds: 50 * HOUR + 70000 });
  f.setTime('2026-11-01T00:05:00+09:00');
  const before = structuredClone(db.contents());
  const preview = await billing.run();
  assert.equal(preview.invoices[0].totalJPY, 13211); assert.equal(preview.errors.length, 0);
  assert.deepStrictEqual(db.contents(), before, 'dry-runでは請求・契約・利用実績を書き換えない');
  assert.equal(stripe.calls.length, 0);
  db.failCommit = true;
  await assert.rejects(billing.snapshot(id, '2026-10', true));
  assert.deepStrictEqual(db.contents(), before, '請求確定失敗では締めマーカーも請求も保存しない');
  const invoice = await billing.snapshot(id, '2026-10', true);
  db.failCommit = true;
  await assert.rejects(billing.claim(invoice.id));
  assert.equal(stripe.calls.length, 0, 'DB失敗時は外部処理なし');
  await Promise.all([billing.issue(invoice.id), billing.issue(invoice.id)]);
  assert.equal(stripe.count('invoice'), 1); assert.equal(stripe.count('mail'), 1);
  const remote = [...stripe.records.values()][0];
  assert.deepStrictEqual(remote.payment_settings.payment_method_types, ['card']);
  assert.equal(remote.collection_method, 'send_invoice'); assert.equal(remote.auto_advance, false);
  assert.equal(remote.due_date, Date.parse('2026-11-30T23:59:59+09:00') / 1000);
  assert.equal(remote.total, 13211);
  assert.equal(remote.lines.data.reduce((n, l) => n + l.amount, 0), remote.total);
  assert(remote.lines.data.every(l => l.invoice === remote.id));
  const fixed = structuredClone((await col('corporateInvoices').doc(invoice.id).get()).data());
  await col('corporateDomains').doc(row.domain).update({ plan: 'standard', contactEmail: 'new@company.example' });
  await billing.run({ execute: true });
  const again = (await col('corporateInvoices').doc(invoice.id).get()).data();
  for (const key of ['terms', 'lines', 'totalJPY', 'usage', 'sourceDigest', 'portalAccountID', 'email'])
    assert.deepStrictEqual(again[key], fixed[key], `再計算・プラン変更でも${key}を保持`);
  assert.equal(stripe.count('invoice'), 1); assert.equal(stripe.count('mail'), 1);
  assert.deepStrictEqual((await col('creditGrants').doc('personal').get()).data(), personal);
  assert.deepStrictEqual(db.records('Mojidas/production/corporateUsageLedger'), before.get('Mojidas/production/corporateUsageLedger')
    ? [...before.get('Mojidas/production/corporateUsageLedger')].map(([id, data]) => ({ id, data })) : []);
  const user = { id: 'portal-a', mustChangePassword: false };
  assert.equal((await billing.history(user)).length, 1);
  assert.equal((await billing.history({ id: 'other' })).length, 0);
  await assert.rejects(billing.link({ id: 'other' }, invoice.id, 'pay'), { code: 'FORBIDDEN' });
  await assert.rejects(billing.link({ ...user, mustChangePassword: true }, invoice.id, 'pay'), { code: 'FORBIDDEN' });
  assert.equal(await billing.link(user, invoice.id, 'pdf'), remote.invoice_pdf);
  remote.invoice_pdf = 'https://evil.example/phish';
  await assert.rejects(billing.link(user, invoice.id, 'pdf'), { code: 'INVOICE_LINK_UNAVAILABLE' });
  remote.invoice_pdf = `https://pay.stripe.com/invoice/${remote.id}/pdf`;
  f.setTime('2026-11-30T23:59:59+09:00');
  assert.equal((await billing.history(user))[0].state, 'open');
  f.setTime('2026-12-01T00:00:00+09:00');
  assert.equal((await billing.history(user))[0].state, 'overdue');
  await Promise.all([billing.sendInvoice(invoice.id, remote.id, 'overdue-once'), billing.sendInvoice(invoice.id, remote.id, 'overdue-once')]);
  assert.equal(stripe.count('mail'), 2, '督促の再送・並行処理でも1回だけ');
  await billing.sendInvoice(invoice.id, remote.id, 'overdue-once'); assert.equal(stripe.count('mail'), 2);
  const event = { id: 'evt_paid', type: 'invoice.paid', data: { object: structuredClone(remote) } };
  remote.status = 'paid'; remote.status_transitions.paid_at = Math.floor(f.now() / 1000);
  const bridge = new MojidasStripeBillingService({ stripeClient: stripe, corporateBillingService: billing });
  await bridge.processWebhookEvent(event); await bridge.processWebhookEvent({ ...event, type: 'invoice.payment_failed' });
  assert.equal((await billing.history(user))[0].state, 'paid', '古い通知でもStripeの最新状態を取得');
  await billing.syncInvoice({ ...remote, status: 'open' }, invoice.id);
  assert.equal((await billing.history(user))[0].state, 'paid', '取得結果の順序逆転でも支払済みを維持');
  await billing.sendInvoice(invoice.id, remote.id, 'extra'); assert.equal(stripe.count('mail'), 2);
  await assert.rejects(billing.syncInvoice({ ...remote, total: 1 }, invoice.id), { code: 'STRIPE_INVOICE_MISMATCH' });
  const settings = await col('corporateDomains').doc(row.domain).get();
  assert.equal(settings.data().status, 'approved', '督促で法人利用を自動停止しない');
}
async function failureChecks() {
  for (const failure of ['customer', 'invoice', 'line', 'finalize', 'mail']) {
    const f = await fixture('metered'); f.setTime('2026-11-01T00:05:00+09:00');
    const invoice = await f.billing.snapshot(f.id, '2026-10', true);
    f.stripe.loseResponse = failure;
    await assert.rejects(f.billing.issue(invoice.id));
    // サービス再作成を含む再試行でも、成功済みの外部操作を重複させない。
    const resumed = new CorporateBillingService({ firestoreProvider: () => f.db, stripeClient: f.stripe, now: f.now, environment: {} });
    await resumed.issue(invoice.id);
    assert.equal(f.stripe.count('customer'), 1, failure);
    assert.equal(f.stripe.count('invoice'), 1, failure);
    assert.equal(f.stripe.count('line'), 1, failure);
    assert.equal(f.stripe.count('finalize'), 1, failure);
    assert.equal(f.stripe.count('mail'), 1, failure);
  }
  for (const failure of ['customer', 'invoice', 'line', 'finalize', 'mail']) {
    const f = await fixture('metered'); f.setTime('2026-11-01T00:05:00+09:00');
    const invoice = await f.billing.snapshot(f.id, '2026-10', true);
    f.stripe.loseResponse = failure; await assert.rejects(f.billing.issue(invoice.id));
    f.setTime(f.now() + 25 * 3600000); f.stripe.cache.clear();
    await f.billing.issue(invoice.id);
    for (const kind of ['customer', 'invoice', 'line', 'finalize', 'mail']) assert.equal(f.stripe.count(kind), 1);
  }
  const f = await fixture('metered'); f.setTime('2026-11-01T00:05:00+09:00');
  const invoice = await f.billing.snapshot(f.id, '2026-10', true);
  f.stripe.loseResponse = 'invoice'; await assert.rejects(f.billing.issue(invoice.id));
  f.setTime(f.now() + 25 * 3600000); f.stripe.cache.clear();
  f.stripe.invoices.list = async () => ({ data: [], has_more: false });
  await assert.rejects(f.billing.issue(invoice.id), { code: 'STRIPE_RESULT_REVIEW_REQUIRED' });
  assert.equal(f.stripe.count('invoice'), 1, 'Stripeの保持期間後に成功を照合できない場合は再発行しない');
}
async function contractChecks() {
  const f = await fixture('light', '2026-11-16T10:00:00+09:00');
  const { billing, db, col, row, id } = f;
  const usage = new CorporateUsageStore({ firestoreProvider: () => db, now: f.now });
  const status = await usage.status({ domain: row.domain, partnerID: 'self' });
  assert.equal(status.limitMilliseconds, 25 * HOUR, 'API側の利用枠も日割り');
  const management = new CorporateManagementStore({ firestoreProvider: () => db, now: f.now,
    authProvider: () => ({ listUsers: async () => ({ users: [] }) }) });
  assert.equal((await management.overview({ id: 'portal-a' }, { domain: row.domain, month: '2026-11' })).estimate.total, 6600);
  await assert.rejects(billing.snapshot(id, '2026-11', true), { code: 'BILLING_MONTH_NOT_CLOSED' });
  f.setTime('2026-12-01T00:00:00+09:00');
  assert.equal((await billing.snapshot(id, '2026-11', true)).totalJPY, 6600);
  const before = structuredClone(db.collections); db.failCommit = true;
  const partner = new PartnerStore({ firestoreProvider: () => db, now: f.now, portalStore: null });
  await assert.rejects(partner.setDomainStatus(row.domain, 'inactive', 'admin'));
  assert.deepStrictEqual(db.collections, before, '契約履歴と法人設定は同時保存・同時ロールバック');
  await partner.setDomainStatus(row.domain, 'inactive', 'admin');
  f.setTime('2027-01-01T00:05:00+09:00');
  assert.equal(await billing.snapshot(id, '2026-12', true), null, '月初から停止中なら請求なし');
  const legacy = await fixture();
  await legacy.col('corporateBillingContracts').doc(legacy.id).delete();
  legacy.setTime('2026-10-29T00:00:00+09:00'); await legacy.billing.observeContracts();
  legacy.setTime('2026-11-01T00:05:00+09:00');
  await assert.rejects(legacy.billing.snapshot(legacy.id, '2026-10', true), { code: 'BILLING_HISTORY_REQUIRED' });
  const saved = structuredClone(legacy.db.collections);
  await legacy.billing.confirmHistory(legacy.row.domain, '2026-10-01', false);
  assert.deepStrictEqual(legacy.db.collections, saved);
  await legacy.billing.confirmHistory(legacy.row.domain, '2026-10-01', true);
  assert.equal((await legacy.billing.snapshot(legacy.id, '2026-10', true)).totalJPY, 13200);
  await assert.rejects(legacy.billing.confirmHistory(legacy.row.domain, '2026-09-01', true), { code: 'BILLING_ALREADY_SNAPSHOTTED' });
  const c = (await col('corporateBillingContracts').doc(id).get()).data();
  const trial = structuredClone(c); trial.events.forEach(e => e.terms.plan = 'trial');
  assert.equal(calculate(trial, '2026-11', {}), null);
  const dealer = structuredClone(c); dealer.events.forEach(e => e.terms.partnerID = 'dealer');
  assert.equal(calculate(dealer, '2026-11', {}), null);
}
async function cliChecks() {
  assert.throws(() => options(['--execute', '--dry-run']));
  assert.throws(() => options(['--domain', 'company.example']));
  const f = await fixture('metered'); f.setTime('2026-11-01T00:05:00+09:00');
  assert.equal(await cli({ args: [], service: f.billing, log: () => {} }), 0);
  assert.equal(f.stripe.count('invoice'), 0);
  assert.equal(await cli({ args: ['--execute'], service: f.billing, log: () => {} }), 0);
  assert.equal(f.stripe.count('invoice'), 1);
}
async function usageChecks() {
  const f = await fixture('trial', '2026-11-01T00:00:00+09:00');
  const usage = new CorporateUsageStore({ firestoreProvider: () => f.db, now: f.now });
  const corporate = { domain: f.row.domain, partnerID: 'self' };
  const args = { corporate, userID: 'member', recognitionRunID: 'trial', clientSessionID: 's', operation: 'realtime', requestedMilliseconds: 0, trackCount: 1 };
  const trial = await usage.create(args, corporate);
  await usage.settle({ userID: 'member', reservationID: trial.id, consumedMilliseconds: 10 * HOUR }, true);
  const originalLedger = structuredClone(f.db.records('Mojidas/production/corporateUsageLedger'));
  f.setTime('2026-11-16T10:00:00+09:00');
  await f.db.runTransaction(async tx => {
    const ref = f.col('corporateDomains').doc(f.row.domain), before = (await tx.get(ref)).data();
    const write = await prepareContractChange(f.db, tx, before, f.now());
    const after = { ...before, plan: 'light', limitMilliseconds: 50 * HOUR };
    tx.set(ref, after); write(after);
  });
  assert.equal((await usage.status(corporate)).usedMilliseconds, 0, 'トライアル分は有料枠から消費しない');
  const paid = await usage.create({ ...args, recognitionRunID: 'paid' }, corporate);
  await usage.settle({ userID: 'member', reservationID: paid.id, consumedMilliseconds: 25 * HOUR + 1 }, true);
  assert.equal((await usage.status(corporate)).usedMilliseconds, 25 * HOUR + 1);
  f.setTime('2026-12-01T00:05:00+09:00');
  const bill = await f.billing.snapshot(f.id, '2026-11', true);
  assert.equal(bill.usedMilliseconds, 25 * HOUR + 1); assert.equal(bill.totalJPY, 6605);
  assert.equal((await f.col('corporateUsageMonths').doc('self_company.example_2026-11').get()).data().realtime, 35 * HOUR + 1);
  for (const original of originalLedger)
    assert.deepStrictEqual((await f.col('corporateUsageLedger').doc(original.id).get()).data(), original.data);
  const edge = await fixture('metered');
  const edgeUsage = new CorporateUsageStore({ firestoreProvider: () => edge.db, now: edge.now });
  edge.setTime('2026-10-31T23:59:59+09:00');
  const ongoing = await edgeUsage.create({ ...args, recognitionRunID: 'month-edge' }, corporate);
  await edgeUsage.settle({ userID: 'member', reservationID: ongoing.id, sequence: 1, consumedMilliseconds: 60001 }, false);
  edge.setTime('2026-11-01T00:05:00+09:00');
  const closed = await edge.billing.snapshot(edge.id, '2026-10', true);
  assert.equal(closed.billableMinutes, 2); assert.equal(closed.totalJPY, 2211);
  await edgeUsage.settle({ userID: 'member', reservationID: ongoing.id, consumedMilliseconds: 120001 }, true);
  await edgeUsage.settle({ userID: 'member', reservationID: ongoing.id, consumedMilliseconds: 120001 }, true);
  assert.equal((await edge.col('corporateUsageMonths').doc('self_company.example_2026-10').get()).data().realtime, 60001);
  assert.equal((await edge.col('corporateUsageMonths').doc('self_company.example_2026-11').get()).data().realtime, 60000);
  assert.deepStrictEqual(await edge.billing.snapshot(edge.id, '2026-10', true), closed, '月跨ぎ・再送でも締め済み請求を保持');
}
async function schedulerChecks() {
  const f = await fixture('metered');
  assert.equal((await f.billing.run({ execute: true })).invoices.length, 0, '当月には発行しない');
  f.setTime('2026-11-01T00:05:00+09:00');
  assert.equal((await f.billing.run({ execute: true })).errors.length, 0);
  assert.equal(f.stripe.count('mail'), 1);
  f.setTime('2026-11-30T23:59:59.999+09:00');
  await f.billing.run({ execute: true }); assert.equal(f.stripe.count('mail'), 1);
  assert.equal((await f.billing.history({ id: 'portal-a' }))[0].state, 'open');
  f.setTime('2026-12-01T00:05:00+09:00');
  await f.billing.run({ execute: true }); assert.equal(f.stripe.count('mail'), 3, '新しい月の請求と前月分の督促');
  f.setTime('2026-12-02T00:05:00+09:00');
  await f.billing.run({ execute: true }); assert.equal(f.stripe.count('mail'), 3, '督促は1回のみ');
  const g = await fixture('metered');
  await g.col('corporateDomains').doc(g.row.domain).update({ portalAccountID: null, contactEmail: '' });
  g.setTime('2026-11-01T00:05:00+09:00');
  await assert.rejects(g.billing.snapshot(g.id, '2026-10', true), { code: 'BILLING_CONTACT_REQUIRED' });
  await g.col('corporateDomains').doc(g.row.domain).update({ portalAccountID: 'new-portal', contactEmail: 'new@company.example' });
  const corrected = await g.billing.snapshot(g.id, '2026-10', true);
  assert.equal(corrected.email, 'new@company.example'); assert.equal(corrected.portalAccountID, 'new-portal');
  assert.equal(corrected.totalJPY, 2200, '締め後の宛先整備で料金履歴を変更しない');
}
async function main() {
  await policyChecks(); await pipelineChecks(); await failureChecks(); await contractChecks(); await usageChecks(); await schedulerChecks(); await cliChecks();
  console.log('法人請求: 日本時間・日割り・端数・契約履歴・再送・クラッシュ・支払通知・他社拒否・利用データ保全の隔離テスト成功');
}
module.exports = { DB, StripeFixture, fixture };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
