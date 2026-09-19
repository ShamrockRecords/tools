const assert = require('assert');
const ejs = require('ejs');
const path = require('path');
const { summarizeMonthlyCredits } = require('../modules/billing/mojidas_monthly_credit_report');
const doc = (id, data) => ({ id, data: () => data });
const minute = 60000;
const input = {
  now: new Date('2026-10-15T00:00:00Z'),
  grantDocuments: [
    doc('free', { type: 'monthlyFree' }), doc('gift', { type: 'promotional' }),
    doc('paid', { type: 'purchased', totalMilliseconds: 60 * minute, remainingMilliseconds: 0,
      createdAt: '2026-08-31T15:00:00Z', metadata: { totalJPY: 330 } }),
    doc('refund', { type: 'purchased', totalMilliseconds: 60 * minute,
      createdAt: '2026-09-19', metadata: { totalJPY: 330 }, refundAdjustmentRun: 'refund-test' }),
    doc('reset', { type: 'purchased', totalMilliseconds: 60 * minute,
      createdAt: '2026-09-19', metadata: { totalJPY: 330 }, releaseReset: 'release-reset' }),
  ],
  ledgerDocuments: [
    doc('grant', { kind: 'grant', grantID: 'paid', milliseconds: 60 * minute,
      occurredAt: '2026-08-31T15:00:00Z', metadata: { type: 'purchased', totalJPY: 330 } }),
    doc('consume-free', { kind: 'consume', milliseconds: -minute, occurredAt: '2026-08-31T14:59:59Z',
      metadata: { allocations: [{ grantID: 'free', milliseconds: minute }] } }),
    doc('consume-mixed', { kind: 'consume', milliseconds: -3 * minute, occurredAt: '2026-08-31T15:00:00Z',
      metadata: { allocations: [{ grantID: 'paid', milliseconds: minute }, { grantID: 'gift', milliseconds: 2 * minute }] } }),
    doc('reserve', { kind: 'reserve', milliseconds: -10 * minute, occurredAt: '2026-09-01' }),
    doc('release', { kind: 'release', milliseconds: 8 * minute, occurredAt: '2026-09-01' }),
    doc('finalize-reacquired', { kind: 'consume', reservationID: 'file', milliseconds: -2 * minute, occurredAt: '2026-09-02' }),
    doc('unknown', { kind: 'consume', milliseconds: -minute, occurredAt: '2026-09-02' }),
    doc('test', { kind: 'consume', milliseconds: -minute, occurredAt: '2026-09-02',
      metadata: { allocations: [{ type: 'testCredit', milliseconds: minute }] } }),
  ],
  reservationDocuments: [
    doc('file', { operation: 'mediaFile', status: 'completed', consumedMilliseconds: 2 * minute,
      completedAt: '2026-09-02', allocations: [{ grantID: 'free', milliseconds: minute }, { grantID: 'paid', milliseconds: 9 * minute }] }),
    doc('translation', { operation: 'formalTranslation', status: 'completed', consumedMilliseconds: minute,
      completedAt: '2026-09-02', allocations: [{ grantID: 'gift', milliseconds: minute }] }),
    ...['held', 'consuming', 'expired', 'cancelled'].map(status => doc(status, {
      operation: 'mediaFile', status, consumedMilliseconds: ['held', 'consuming'].includes(status) ? 999999 : 0, completedAt: '2026-09-02',
      allocations: [{ grantID: 'paid', milliseconds: 999999 }],
    })),
  ],
};
const before = JSON.stringify(input);
const report = summarizeMonthlyCredits(input);
assert.deepStrictEqual(report.rows.map(row => row.month), ['2026-10', '2026-09', '2026-08']);
const september = report.rows[1];
assert.deepStrictEqual([september.monthlyFree, september.purchased, september.promotional, september.unknown,
  september.total, september.purchasedMilliseconds, september.purchaseJPY], [1, 2, 3, 1, 7, 60, 330].map((n, i) => i === 6 ? n : n * minute));
assert.strictEqual(report.rows[2].total, minute);
assert.strictEqual(report.rows[0].total, 0);
assert.strictEqual(JSON.stringify(input), before);
assert.deepStrictEqual(summarizeMonthlyCredits(input), report);

const legacy = summarizeMonthlyCredits({ now: input.now, grantDocuments: [], reservationDocuments: [
  doc('single', { operation: 'realtime', allocations: [{ type: 'monthlyFree' }] }),
  doc('mixed', { operation: 'realtime', allocations: [{ type: 'monthlyFree' }, { type: 'purchased' }] }),
], ledgerDocuments: [
  doc('a', { kind: 'consume', reservationID: 'single', milliseconds: -minute, occurredAt: '2026-09-01' }),
  doc('b', { kind: 'consume', reservationID: 'mixed', milliseconds: -minute, occurredAt: '2026-09-01' }),
  doc('c', { kind: 'grant', grantID: 'deleted', milliseconds: minute, occurredAt: '2026-09-01', metadata: { type: 'purchased' } }),
  doc('d', { kind: 'consume', milliseconds: -minute }),
] });
assert.strictEqual(legacy.rows[1].monthlyFree, minute);
assert.strictEqual(legacy.rows[1].unknown, minute);
assert.strictEqual(legacy.rows[1].unvaluedPurchases, 1);
assert.strictEqual(legacy.undatedRecords, 1);

const cancelledUsage = summarizeMonthlyCredits({ now: input.now, grantDocuments: [], ledgerDocuments: [],
  reservationDocuments: [doc('cancelled-with-consumption', { operation: 'mediaFile', status: 'cancelled',
    completedAt: '2026-09-30T15:00:00Z', consumedMilliseconds: minute,
    allocations: [{ type: 'purchased', milliseconds: 10 * minute }] })],
});
assert.strictEqual(cancelledUsage.rows[0].month, '2026-10');
assert.strictEqual(cancelledUsage.rows[0].purchased, minute, '取消でも実際の確定消費を落とさない');

ejs.renderFile(path.join(__dirname, '../views/admin/mojidas-paid-balance.ejs'), {
  report: { monthly: report, asOf: input.now, isComplete: true, unusedPaidBalanceJPY: 0,
    thresholdUsageRate: 0, purchaseGrantCount: 0, totalRemainingMilliseconds: 0,
    unvaluedRemainingMilliseconds: 0, breakdown: [] },
  user: { email: 'admin@example.test' }, formatDate: String, formatJPY: String,
  formatDuration: String, formatMonthlyDuration: String,
}).then(html => {
  assert(html.includes('月別の使用時間・購入実績'));
  assert(html.includes('2026-09'));
  console.log('月別時間集計・表示テスト成功');
}).catch(error => { console.error(error); process.exitCode = 1; });
