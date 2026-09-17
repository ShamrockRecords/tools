const assert = require('assert');
const { planReset, idFor } = require('../scripts/reset_mojidas_release_credits');
const now = new Date('2026-09-17T09:00:00Z');
const users = [{ uid: 'first', createdAt: '2026-08-01T00:00:00Z' }, { uid: 'new', createdAt: '2026-09-10T00:00:00Z' }];
const grants = [
  { id: 'purchase', data: { userID: 'first', type: 'purchased', remainingMilliseconds: 1000000 } },
  { id: 'test', data: { userID: 'first', type: 'testCredit', remainingMilliseconds: 9999999 } },
  { id: 'gift1', data: { userID: 'first', type: 'promotional', remainingMilliseconds: 1000 } },
  { id: 'gift2', data: { userID: 'first', type: 'promotional', remainingMilliseconds: 9999999 } },
  { id: 'expired', data: { userID: 'first', type: 'monthlyFree', remainingMilliseconds: 5000, expiresAt: new Date('2026-08-01') } },
  { id: 'other', data: { userID: 'unrelated', type: 'promotional', remainingMilliseconds: 100000 } },
];
const original = JSON.stringify(grants);
const changes = planReset(users, grants, now);
assert.equal(JSON.stringify(grants), original, '入力を変更しない');
for (const id of ['purchase', 'test', 'expired', 'other']) assert(!changes.some(item => item.id === id));
const updated = new Map(grants.map(item => [item.id, item.data]));
changes.forEach(change => updated.set(change.id, change.after));
for (const user of users) {
  const active = [...updated.values()].filter(item => item.userID === user.uid && (!item.expiresAt || item.expiresAt > now));
  const sum = type => active.filter(item => item.type === type).reduce((sum, item) => sum + item.remainingMilliseconds, 0);
  assert.equal(sum('monthlyFree'), 1800000);
  assert.equal(sum('promotional'), 3600000);
  assert(updated.has(idFor('credit', `${user.uid}:signup-gift-v1`)), '新規特典の二重追加を防ぐID');
}
assert.throws(() => planReset([{ uid: 'invalid', createdAt: 'invalid' }], [], now));
assert.throws(() => planReset(Array.from({ length: 120 }, (_, i) => ({ uid: `u${i}`, createdAt: now })), [], now));
const again = planReset(users, [...updated].map(([id, data]) => ({ id, data })), now);
assert(again.every(item => item.before.remainingMilliseconds === item.after.remainingMilliseconds), '再計画でも積み増さない');
console.log('リリース残高リセット: 指定残高・購入とテスト時間保全・期限・対象分離・二重付与防止を確認');
