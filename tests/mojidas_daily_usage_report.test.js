const assert = require('assert');
const ejs = require('ejs');
const path = require('path');
const { validMonth, summarizeDailyUsage } = require('../modules/billing/mojidas_daily_usage_report');
const { MojidasPaidBalanceStore } = require('../modules/billing/mojidas_paid_balance_store');
const doc = (id, value) => ({ id, data: () => value });
const hour = 3600000;
const consume = (id, occurredAt, type) => doc(id, { kind: 'consume', occurredAt, milliseconds: -hour,
  metadata: { allocations: [{ type, milliseconds: hour }] } });
async function main() {
  const input = { now: new Date('2026-10-01'), grantDocuments: [], reservationDocuments: [
    doc('file', { operation: 'mediaFile', status: 'completed', completedAt: '2026-09-02',
      consumedMilliseconds: hour, allocations: [{ type: 'purchased', milliseconds: 4 * hour }] }),
    doc('pending', { operation: 'mediaFile', status: 'held', consumedMilliseconds: hour }),
  ], ledgerDocuments: [
    consume('before', '2026-08-31T14:59:59Z', 'purchased'),
    consume('start', '2026-08-31T15:00:00Z', 'monthlyFree'),
    consume('gift', '2026-09-01', 'promotional'),
    consume('paid', '2026-09-30T14:59:59Z', 'purchased'),
    consume('after', '2026-09-30T15:00:00Z', 'purchased'),
    consume('unknown', '2026-09-01', undefined),
    consume('test', '2026-09-01', 'testCredit'),
    doc('duplicate-file', { kind: 'consume', reservationID: 'file', occurredAt: '2026-09-02', milliseconds: -hour }),
    doc('reserve', { kind: 'reserve', occurredAt: '2026-09-01', milliseconds: -hour }),
  ], corporateDocuments: [doc('corp', { occurredAt: '2026-09-01', milliseconds: 2 * hour })] };
  const before = JSON.stringify(input);
  const report = summarizeDailyUsage(input, '2026-09');
  assert.equal(report.rows.length, 30);
  assert.deepStrictEqual(report.totals, { free: 2 * hour, paid: 2 * hour, unknown: hour, corporate: 2 * hour, total: 7 * hour });
  assert.equal(report.rows[0].free, 2 * hour);
  assert.equal(report.rows[29].paid, hour);
  assert.equal(report.rows[2].total, 0);
  assert.equal(summarizeDailyUsage(input, '2024-02').rows.length, 29);
  assert.equal(summarizeDailyUsage(input, '2025-02').rows.length, 28);
  assert.equal(JSON.stringify(input), before);
  for (const invalid of ['2026-13', '2026-1', '', ['2026-09'], '../../etc']) assert(!validMonth(invalid));
  assert.throws(() => summarizeDailyUsage(input, '2026-00'));
  const reads = [];
  const store = new MojidasPaidBalanceStore({ now: () => input.now.getTime(), firestoreProvider: () => ({
    collection: name => ({ doc: id => ({ collection: sub => sub }) }),
    runTransaction: async (fn, options) => {
      assert.equal(options.readOnly, true);
      return fn({ get: async name => { reads.push(name); return { docs: [] }; } });
    },
  }) });
  assert.equal((await store.getDailyReport('2026-09')).rows.length, 30);
  assert.equal(reads.length, 4);
  const html = await ejs.renderFile(path.join(__dirname, '../views/admin/mojidas-usage.ejs'), {
    report, user: { email: '<admin>' }, formatDate: String, formatHours: value => String(value / hour),
  });
  assert(html.includes('2026-09-30'));
  assert(html.includes('name="month"'));
  assert(!html.includes('type="submit"'));
  assert(html.includes("addEventListener('change'"));
  assert(html.includes('this.form.requestSubmit()'));
  assert(html.includes('&lt;admin&gt;'));
  const router = require('../routes/admin');
  const route = router.stack.find(layer => layer.route?.path === '/mojidas-usage').route;
  let redirect;
  await route.stack[0].handle({ session: {} }, { redirect: value => { redirect = value; } }, () => assert.fail('認証を迂回'));
  assert(redirect);
  let status;
  await route.stack[1].handle({ query: { month: 'bad' } }, { status: code => { status = code; return { send() {} }; } });
  assert.equal(status, 400);
  let rendered;
  await route.stack[1].handle({ query: { month: '2026-09' }, adminUser: { email: 'admin' },
    app: { locals: { mojidasPaidBalanceStore: { getDailyReport: async month => { assert.equal(month, '2026-09'); return report; } } } },
  }, { render: (view, values) => { rendered = view; assert.equal(values.report, report); } }, error => { throw error; });
  assert.equal(rendered, 'admin/mojidas-usage');
  console.log('日別利用実績: 日付境界・無料/有料/法人・二重計上防止・読取専用・認証・表示 成功');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
