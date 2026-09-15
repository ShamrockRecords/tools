const assert = require('assert');
const { nextUsage, monthAt } = require('../modules/partners/usage_policy');
const identity = Object.freeze({ domain: 'example.co.jp', partnerID: 'partner-a' });
const original = Object.freeze({ userID: 'member', operation: 'realtime', corporate: identity,
  consumedMilliseconds: 0, requestedMilliseconds: 0, sequence: 0, status: 'consuming' });
const report = { userID: 'member', consumedMilliseconds: 3000, sequence: 1, clientRequest: true };
let result = nextUsage(original, report);
assert.equal(result.delta, 3000);
assert.equal(original.consumedMilliseconds, 0);
assert.strictEqual(result.row.corporate, identity);
assert.equal(nextUsage(result.row, report).delta, 0);
assert.equal(nextUsage(result.row, { ...report, consumedMilliseconds: 9999 }).delta, 0);
result = nextUsage(result.row, { ...report, sequence: 2, consumedMilliseconds: 2000 });
assert.equal(result.delta, 0);
result = nextUsage(result.row, { ...report, finish: true, consumedMilliseconds: 4000 });
assert.equal(result.delta, 1000);
assert.equal(result.row.status, 'completed');
assert.equal(nextUsage(result.row, { ...report, finish: true, consumedMilliseconds: 9999 }).delta, 0);
assert.throws(() => nextUsage(result.row, report), { code: 'RESERVATION_CLOSED' });
assert.throws(() => nextUsage(original, { ...report, userID: 'other' }), { code: 'RESERVATION_NOT_FOUND' });
for (const consumedMilliseconds of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
  assert.throws(() => nextUsage(original, { ...report, consumedMilliseconds }), { code: 'INVALID_USAGE' });
const media = { ...original, operation: 'mediaFile', requestedMilliseconds: 10000, status: 'held' };
assert.equal(nextUsage(media, report).delta, 0);
assert.equal(nextUsage(media, { ...report, finish: true }).delta, 3000);
assert.equal(nextUsage(media, { ...report, finish: true, consumedMilliseconds: 20000 }).delta, 10000);
assert.equal(nextUsage(media, { ...report, finish: true, cancelled: true, consumedMilliseconds: 0 }).delta, 0);
assert.equal(nextUsage(media, { ...report, finish: true, cancelled: true, consumedMilliseconds: 10000 }).delta, 10000);
const translation = { ...media, operation: 'formalTranslation', requestedMilliseconds: 5000 };
assert.throws(() => nextUsage(translation, { ...report, finish: true }), { code: 'RESERVATION_SERVER_MANAGED' });
assert.equal(nextUsage(translation, { ...report, finish: true, clientRequest: false }).delta, 3000);
assert.equal(monthAt(Date.UTC(2026, 8, 30, 14, 59, 59)), '2026-09');
assert.equal(monthAt(Date.UTC(2026, 8, 30, 15)), '2026-10');
// 切替後の権利情報を渡しても開始時の法人が変わらない。
assert.strictEqual(nextUsage(original, { ...report, corporate: null }).row.corporate, identity);
assert.throws(() => nextUsage({ ...original, corporate: null }, report), { code: 'NOT_CORPORATE' });
console.log('法人利用計算: 再送・上限・所有者・正式翻訳・開始時区分・日本時間月境界のテスト成功');
