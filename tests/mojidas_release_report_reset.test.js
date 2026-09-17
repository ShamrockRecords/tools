const assert = require('assert');
const { idFor } = require('../scripts/reset_mojidas_release_credits');
const { planReportReset } = require('../scripts/reset_mojidas_release_report');
const { summarizePaidBalance } = require('../modules/billing/mojidas_paid_balance_store');
const users = [{ uid: 'sample' }];
const grants = [
  { id: 'paid', data: { userID: 'sample', type: 'purchased', remainingMilliseconds: 9000000, totalMilliseconds: 9000000 } },
  { id: 'free', data: { userID: 'sample', type: 'monthlyFree', remainingMilliseconds: 1800000 } },
  { id: 'test', data: { userID: 'sample', type: 'testCredit', remainingMilliseconds: 99999999 } },
  { id: 'old', data: { userID: 'sample', type: 'promotional', totalMilliseconds: 999999, remainingMilliseconds: 0 } },
  { id: idFor('credit', 'sample:signup-gift-v1'), data: { userID: 'sample', type: 'promotional', totalMilliseconds: 9000000, remainingMilliseconds: 3600000 } },
];
const original = JSON.stringify(grants), changes = planReportReset(users, grants);
assert.equal(JSON.stringify(grants), original);
assert(!changes.some(item => ['free', 'test'].includes(item.id)));
assert.equal(changes.find(item => item.id === 'paid').after.remainingMilliseconds, 0);
assert.equal(changes.find(item => item.id === 'paid').after.totalMilliseconds, 9000000);
assert.equal(changes.find(item => item.id === 'old').after, null);
const map = new Map(grants.map(item => [item.id, item.data]));
for (const change of changes) { if (change.after) map.set(change.id, change.after); else map.delete(change.id); }
const docs = [...map].map(([id, data]) => ({ id, data: () => data }));
const report = summarizePaidBalance({ grantDocuments: docs, promotionalDocuments: docs, ledgerDocuments: [], now: new Date() });
assert.equal(report.unusedPaidBalanceJPY, 0);
assert.equal(report.promotional.grantCount, 1);
assert.equal(report.promotional.grantedMilliseconds, 3600000);
assert.equal(report.promotional.consumedMilliseconds, 0);
assert.throws(() => planReportReset(users, grants.filter(item => item.data.type !== 'promotional')));
assert.throws(() => planReportReset(users, grants.map(item => item.id === 'old' ? { ...item, data: { ...item.data, remainingMilliseconds: 1 } } : item)));
console.log('集計リセット: 購入枠ID保持・無料枠保全・旧無償退避・集計ゼロ化の隔離テスト成功');
