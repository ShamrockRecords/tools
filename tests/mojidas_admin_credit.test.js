const assert = require('assert');
const { randomUUID } = require('crypto');
const { MojidasAdminUserStore } = require('../modules/auth/mojidas_admin_user_store');
const { MojidasCreditStore } = require('../modules/credit/mojidas_credit_store');
const { TransactionalFirestore } = require('./mojidas_credit_integrity.test');

async function main() {
  const now = Date.parse('2026-09-11T00:00:00Z');
  const db = new TransactionalFirestore();
  const credits = new MojidasCreditStore({ firestoreProvider: () => db, now: () => now, monthlyFreeAllowanceMilliseconds: 1800000 });
  const users = ['target', 'other', 'invited'].map(uid => ({ uid, metadata: { creationTime: new Date(now).toISOString() },
    customClaims: { mojidasInvitedUnlimited: uid === 'invited' } }));
  const auth = {
    async listUsers() { return { users }; },
    async getUser(uid) {
      const user = users.find(item => item.uid === uid);
      if (!user) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' });
      return user;
    },
  };
  const admin = new MojidasAdminUserStore({ authProvider: () => auth, credits, firestoreProvider: () => db });
  const initial = await admin.listUsers();
  assert.equal(initial.users[0].credit.monthlyFreeMilliseconds, 1800000);
  assert.equal(initial.users[0].credit.purchasedMilliseconds, 0);
  assert(initial.users[2].credit.otherMilliseconds > 0);
  const add = { uid: 'target', hours: '2', operationID: randomUUID(), adminEmail: 'admin@example.invalid' };
  const before = structuredClone(db.collections);
  for (const hours of ['0', '-1', '1.5', 'NaN', 'Infinity', '1e2', '100001', '', null]) {
    await assert.rejects(() => admin.addPromotionalHours({ ...add, hours }), error => error.code === 'INVALID_ADMIN_CREDIT');
  }
  await assert.rejects(() => admin.addPromotionalHours({ ...add, operationID: 'bad' }));
  await assert.rejects(() => admin.addPromotionalHours({ ...add, uid: 'missing' }), error => error.code === 'auth/user-not-found');
  assert.deepStrictEqual(db.collections, before);
  await Promise.all([admin.addPromotionalHours(add), admin.addPromotionalHours(add)]);
  let listed = await admin.listUsers();
  assert.equal(listed.users[0].credit.promotionalMilliseconds, 7200000);
  assert.equal(listed.users[0].credit.totalMilliseconds, 9000000);
  assert.deepStrictEqual(listed.users[1].credit, initial.users[1].credit);
  assert.deepStrictEqual(listed.users[2].credit, initial.users[2].credit);
  const after = structuredClone(db.collections);
  await assert.rejects(() => admin.addPromotionalHours({ ...add, hours: '3' }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.deepStrictEqual(db.collections, after);
  const grants = db.records('Mojidas/production/creditGrants').filter(item => item.data.type === 'promotional');
  assert.equal(grants.length, 1);
  assert.equal(grants[0].data.metadata.adminEmail, add.adminEmail);
  assert.equal(grants[0].data.metadata.source, 'admin');
  assert.equal(grants[0].data.expiresAt, null);
  const account = { userID: 'target', accountCreatedAt: new Date(now) };
  const reservation = await credits.createReservation({ ...account, operation: 'realtime', clientSessionID: 'live', recognitionRunID: 'run', requestedMilliseconds: 0, trackCount: 1 });
  await credits.completeReservation({ ...account, reservationID: reservation.id, consumedMilliseconds: 2100000 });
  listed = await admin.listUsers();
  assert.equal(listed.users[0].credit.monthlyFreeMilliseconds, 0);
  assert.equal(listed.users[0].credit.promotionalMilliseconds, 6900000);
  await admin.addPromotionalHours(add);
  assert.equal((await admin.listUsers()).users[0].credit.promotionalMilliseconds, 6900000, '消費後の再送も再付与しない');
  await admin.addPromotionalHours({ ...add, operationID: randomUUID(), hours: '1' });
  assert.equal((await admin.listUsers()).users[0].credit.promotionalMilliseconds, 10500000);
  // 決済分は独立した有償残高として保持し、無償提供を金額集計へ混ぜない。
  await credits.grantCredit({ userID: 'target', type: 'purchased', milliseconds: 3600000,
    idempotencyKey: 'stripe-fixture', metadata: { totalJPY: 330, productID: 'paid-fixture' } });
  const { MojidasPaidBalanceStore } = require('../modules/billing/mojidas_paid_balance_store');
  const reports = new MojidasPaidBalanceStore({ firestoreProvider: () => db, now: () => now });
  const report = await reports.getReport();
  assert.equal(report.unusedPaidBalanceJPY, 330);
  assert.equal(report.isComplete, true);
  assert.equal(report.totalRemainingMilliseconds, 3600000);
  assert.equal(report.purchaseGrantCount, 1);
  assert.equal(report.promotional.grantedMilliseconds, 10800000);
  assert.equal(report.promotional.remainingMilliseconds, 10500000);
  assert.equal(report.promotional.consumedMilliseconds, 300000);
  assert.equal(report.promotional.breakdown[0].reason, 'プロモーション');
  assert.equal(report.promotional.grantCount, 2);
  const media = await credits.createReservation({ ...account, operation: 'mediaFile',
    clientSessionID: 'file', recognitionRunID: 'media-run', requestedMilliseconds: 600000, trackCount: 1 });
  assert.deepStrictEqual((await reports.getReport()).promotional, report.promotional, '予約中の未消費分は使用済みにしない');
  await credits.completeReservation({ ...account, reservationID: media.id, consumedMilliseconds: 300000 });
  const settled = await reports.getReport();
  assert.equal(settled.unusedPaidBalanceJPY, 330, '無償提供を有償購入より先に消費する');
  assert.equal(settled.promotional.remainingMilliseconds, 10200000);
  assert.equal(settled.promotional.consumedMilliseconds, 600000);
  assert.equal(settled.promotional.grantedMilliseconds,
    settled.promotional.remainingMilliseconds + settled.promotional.consumedMilliseconds + settled.promotional.expiredMilliseconds);
  const broken = new MojidasAdminUserStore({ authProvider: () => auth, credits: { async getBalance() { throw new Error('fixture unavailable'); } } });
  assert.equal((await broken.listUsers()).users[0].credit, null, '取得失敗をゼロにしない');
  console.log('管理者無償時間: 残高内訳、入力検証、並行二重送信、再送競合、無料優先消費、他ユーザー保全、監査情報を検証');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
