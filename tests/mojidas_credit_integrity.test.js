const assert = require('assert');
const { FakeFirestore } = require('./mojidas_credit_store.test');
const { MojidasCreditStore, RESERVATION_LEASE_MILLISECONDS } = require('../modules/credit/mojidas_credit_store');

// 実際のtransactionと同様、競合処理を直列化し、失敗時の書き込みを全量戻す。
class TransactionalFirestore extends FakeFirestore {
  constructor() { super(); this.tail = Promise.resolve(); }
  runTransaction(callback) {
    const task = this.tail.then(async () => {
      const before = structuredClone(this.collections);
      let hasWritten = false;
      try {
        return await callback({
          get: (ref) => { assert(!hasWritten, 'transactionの読み取りは書き込みより前に行う'); return ref.get(); },
          set: (...args) => { hasWritten = true; return args[0].set(...args.slice(1)); },
          update: (...args) => { hasWritten = true; return args[0].update(...args.slice(1)); },
          delete: (ref) => { hasWritten = true; return ref.delete(); },
        });
      } catch (error) { this.collections = before; throw error; }
    });
    this.tail = task.catch(() => {});
    return task;
  }
}

async function scenario(isUnlimited) {
  let now = Date.parse('2026-09-10T00:00:00Z');
  const db = new TransactionalFirestore();
  const store = new MojidasCreditStore({ firestoreProvider: () => db, now: () => now, monthlyFreeAllowanceMilliseconds: 1000 });
  const account = { userID: 'fixture-user', accountCreatedAt: new Date(now), isUnlimited };
  await store.ensureAccountGrants(account);
  await store.grantCredit({userID: account.userID, type:'purchased', milliseconds:5000, idempotencyKey:'purchase-fixture'});
  const balance = () => store.getBalance(account);
  const records = () => db.records('Mojidas/production/creditReservations');
  const remaining = (type) => db.records('Mojidas/production/creditGrants').filter(x => x.data.type === type).reduce((sum,x) => sum+x.data.remainingMilliseconds,0);
  const reserve = (id,operation='realtime',amount=0) => store.createReservation({...account, operation, clientSessionID:id, recognitionRunID:id, requestedMilliseconds:amount, trackCount:1});
  const report = (reservation,sequence,consumed) => store.heartbeat({...account,reservationID:reservation.id,sequence,consumedMilliseconds:consumed,clientRequest:true});
  const finish = (reservation,consumed,cancelled=false) => store.completeReservation({userID:account.userID,reservationID:reservation.id,consumedMilliseconds:consumed,cancelled,clientRequest:true});
  const initial = (await balance()).availableMilliseconds;
  const [a,b] = await Promise.all([reserve('a'),reserve('b')]);
  await Promise.all([report(a,1,700),report(b,1,700)]);
  assert.strictEqual(remaining('monthlyFree'),0);
  assert.strictEqual(remaining('purchased'),4600);
  assert.strictEqual((await balance()).availableMilliseconds,initial-1400);
  await Promise.all([report(a,1,700),report(b,1,700)]);
  assert.strictEqual((await balance()).availableMilliseconds,initial-1400);
  await Promise.all([finish(a,800),finish(b,800)]);
  assert.strictEqual(remaining('purchased'),4400);
  await finish(a,800);
  assert.strictEqual((await balance()).availableMilliseconds,initial-1600);
  const consumptionEvents = db.records('Mojidas/production/usageLedger')
    .map(record => record.data).filter(event => event.kind === 'consume');
  assert.strictEqual(consumptionEvents.length, 4, '再送で消費履歴を増やさない');
  const byType = {};
  for (const event of consumptionEvents) {
    assert.strictEqual(event.metadata.allocations.reduce((sum, item) => sum + item.milliseconds, 0), -event.milliseconds);
    for (const item of event.metadata.allocations) {
      assert(item.grantID);
      byType[item.type] = (byType[item.type] || 0) + item.milliseconds;
    }
  }
  assert.deepStrictEqual(byType, { monthlyFree: 1000, purchased: 600 }, 'heartbeatと最終精算の消費元を保存');
  const snapshotBeforeReport = structuredClone(db.collections);
  const { MojidasPaidBalanceStore } = require('../modules/billing/mojidas_paid_balance_store');
  const monthlyReport = await new MojidasPaidBalanceStore({ firestoreProvider: () => db, now: () => now }).getReport();
  assert.strictEqual(monthlyReport.monthly.rows[0].monthlyFree, 1000);
  assert.strictEqual(monthlyReport.monthly.rows[0].purchased, 600);
  assert.strictEqual(monthlyReport.monthly.rows[0].total, 1600);
  assert.deepStrictEqual(db.collections, snapshotBeforeReport, '集計で残高・履歴を変更しない');
  await assert.rejects(()=>report(a,2,900),e=>e.code==='RESERVATION_CLOSED');

  const live = await reserve('late-live');
  await report(live,1,100);
  now += RESERVATION_LEASE_MILLISECONDS + 1;
  await balance();
  assert.strictEqual(records().find(x=>x.id===live.id).data.status,'expired');
  await report(live,2,300);
  assert.strictEqual(records().find(x=>x.id===live.id).data.status,'consuming');
  await report(live,2,300);
  assert.strictEqual((await balance()).availableMilliseconds,initial-1900);
  now += RESERVATION_LEASE_MILLISECONDS + 1;
  await balance();
  await finish(live,400);
  await finish(live,400);
  assert.strictEqual((await balance()).availableMilliseconds,initial-2000);

  const media = await reserve('media','mediaFile',1000);
  assert.strictEqual((await balance()).availableMilliseconds,initial-3000);
  await finish(media,350);
  assert.strictEqual((await balance()).availableMilliseconds,initial-2350);
  const lateMedia = await reserve('late-media','mediaFile',1000);
  now = lateMedia.leaseExpiresAt.getTime()+1;
  await balance();
  assert.strictEqual((await balance()).availableMilliseconds,initial-2350);
  await finish(lateMedia,250);
  await finish(lateMedia,250);
  assert.strictEqual((await balance()).availableMilliseconds,initial-2600);

  const formal = await reserve('formal','formalTranslation',300);
  const beforeForbidden = structuredClone(db.collections);
  await assert.rejects(()=>finish(formal,0,true),e=>e.code==='RESERVATION_SERVER_MANAGED');
  await assert.rejects(()=>report(formal,1,0),e=>e.code==='RESERVATION_SERVER_MANAGED');
  assert.deepStrictEqual(db.collections,beforeForbidden);
  const settled = await store.completeReservation({userID:account.userID,reservationID:formal.id,consumedMilliseconds:300});
  assert.strictEqual(settled.status,'completed');
  assert.strictEqual(settled.consumedMilliseconds,300);
  assert.strictEqual((await balance()).availableMilliseconds,initial-2900);

  const failed = await reserve('failed-media','mediaFile',500);
  await finish(failed,0,true);
  assert.strictEqual((await balance()).availableMilliseconds,initial-2900);
  const cancelled = await reserve('cancelled-media','mediaFile',500);
  await finish(cancelled,500,true);
  assert.strictEqual((await balance()).availableMilliseconds,initial-3400);
  const otherUserState = structuredClone(db.collections);
  await assert.rejects(()=>store.heartbeat({userID:'other-user',accountCreatedAt:account.accountCreatedAt,reservationID:live.id,sequence:99,consumedMilliseconds:900}),e=>e.code==='RESERVATION_NOT_FOUND');
  // 他者の予約、残高、台帳は変更しない（他者自身への無料付与を除く）。
  for (const [name,items] of otherUserState) for (const [id,value] of items) assert.deepStrictEqual(db.collections.get(name).get(id),value);

  if (isUnlimited) {
    assert.strictEqual((await balance()).isUnlimited,true);
    const normal = await store.getBalance({...account,isUnlimited:false});
    assert.strictEqual(normal.availableMilliseconds,2600);
    const testGrant = db.records('Mojidas/production/creditGrants').find(x=>x.data.type==='testCredit');
    assert(testGrant && testGrant.data.metadata.testOnly);
    const large = await reserve('large-test');
    await report(large,1,10000);
    assert(remaining('testCredit') < testGrant.data.remainingMilliseconds);
  } else {
    const exhausted = await reserve('exhaust');
    await assert.rejects(()=>report(exhausted,1,5000),e=>e.code==='INSUFFICIENT_CREDIT');
    assert.strictEqual((await balance()).availableMilliseconds,0);
    await assert.rejects(()=>report(exhausted,1,5000),e=>e.code==='INSUFFICIENT_CREDIT');
    await finish(exhausted,5000);
    assert.strictEqual((await balance()).availableMilliseconds,0);
  }
  console.log(`credit-integrity: ${isUnlimited ? '無制限テスト残高' : '通常購入残高'}の並行消費・再送・復旧・確定・返却を検証`);
}

async function main() {
  await scenario(false);
  await scenario(true);
  await recoveryAccounting();
}

async function recoveryAccounting() {
  let now = Date.parse('2026-09-10T00:00:00Z');
  const db = new TransactionalFirestore();
  const store = new MojidasCreditStore({ firestoreProvider: () => db, now: () => now, monthlyFreeAllowanceMilliseconds: 1000 });
  const account = { userID: 'recovery-fixture', accountCreatedAt: new Date(now), isUnlimited: false };
  await store.grantCredit({ userID: account.userID, type: 'purchased', milliseconds: 5000, idempotencyKey: 'paid' });
  const initial = (await store.getBalance(account)).availableMilliseconds;
  const reserve = (id, operation, amount) => store.createReservation({ ...account, clientSessionID: id, recognitionRunID: id, operation, requestedMilliseconds: amount, trackCount: 1 });
  const media = await reserve('repeated-expiry', 'mediaFile', 1500);
  const reservation = () => db.records('Mojidas/production/creditReservations').find(x => x.id === media.id).data;
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    now = reservation().leaseExpiresAt.getTime() + 1;
    await store.getBalance(account);
    assert.strictEqual((await store.getBalance(account)).availableMilliseconds, initial);
    await store.heartbeat({ ...account, reservationID: media.id, sequence, consumedMilliseconds: 0 });
    assert.strictEqual((await store.getBalance(account)).availableMilliseconds, initial - 1500);
  }
  await store.completeReservation({ ...account, reservationID: media.id, consumedMilliseconds: 1200 });
  const grants = db.records('Mojidas/production/creditGrants');
  assert.strictEqual(grants.find(x => x.data.type === 'monthlyFree').data.remainingMilliseconds, 0);
  assert.strictEqual(grants.find(x => x.data.type === 'purchased').data.remainingMilliseconds, 4800);
  const ledgerTotal = db.records('Mojidas/production/usageLedger').reduce((sum, x) => sum + x.data.milliseconds, 0);
  assert.strictEqual(ledgerTotal, initial - 1200, '再取得ごとの返却が台帳で上書きされない');

  const live = await reserve('month-boundary', 'realtime', 0);
  now = Date.parse('2026-10-10T00:00:01Z');
  await store.completeReservation({ ...account, reservationID: live.id, consumedMilliseconds: 800 });
  const after = await store.getBalance(account);
  assert.strictEqual(after.expiringMilliseconds, 200, '停止通知だけでも新しい月の無料枠を先に使う');
  assert.strictEqual(after.purchasedMilliseconds, 4800);

  const pendingFile = await reserve('pending-file', 'mediaFile', 5000);
  now = pendingFile.leaseExpiresAt.getTime() + 1;
  await store.getBalance(account);
  const competing = await reserve('competing-live', 'realtime', 0);
  await store.completeReservation({ ...account, reservationID: competing.id, consumedMilliseconds: 4900 });
  const beforeInsufficientFinal = structuredClone(db.collections);
  await assert.rejects(() => store.completeReservation({ ...account, reservationID: pendingFile.id, consumedMilliseconds: 250 }),
    e => e.code === 'INSUFFICIENT_CREDIT');
  assert.deepStrictEqual(db.collections, beforeInsufficientFinal, '返却済みfileの確定不足で部分消費や状態変更をしない');
  await store.grantCredit({ userID: account.userID, type: 'purchased', milliseconds: 1000, idempotencyKey: 'top-up' });
  await store.completeReservation({ ...account, reservationID: pendingFile.id, consumedMilliseconds: 250 });
  await store.completeReservation({ ...account, reservationID: pendingFile.id, consumedMilliseconds: 250 });
  assert.strictEqual((await store.getBalance(account)).availableMilliseconds, 850, '補充後の再送で最終250msだけを一度確定する');

  // 更新前に作られた無制限の空allocation予約も、更新後の確定を台帳に反映する。
  const invited = { userID: 'legacy-invited', accountCreatedAt: new Date(now), isUnlimited: true };
  await store.ensureAccountGrants(invited);
  const old = await store.createReservation({ ...invited, clientSessionID: 'old', recognitionRunID: 'old', operation: 'mediaFile', requestedMilliseconds: 0, trackCount: 1 });
  await store.collection('creditReservations').doc(old.id).update({ requestedMilliseconds: 2000, accountingVersion: null, allocations: [] });
  const oldInitial = (await store.getBalance(invited)).availableMilliseconds;
  await store.completeReservation({ ...invited, reservationID: old.id, consumedMilliseconds: 1500 });
  assert.strictEqual((await store.getBalance(invited)).availableMilliseconds, oldInitial - 1500);
  assert.strictEqual(db.records('Mojidas/production/usageLedger').filter(x => x.data.reservationID === old.id).reduce((sum,x) => sum + x.data.milliseconds, 0), -1500);

  const outstanding = await store.createReservation({ ...invited, clientSessionID: 'demote', recognitionRunID: 'demote', operation: 'realtime', requestedMilliseconds: 0, trackCount: 1 });
  await assert.rejects(() => store.heartbeat({ ...invited, isUnlimited: false, reservationID: outstanding.id, sequence: 1, consumedMilliseconds: 100 }), e => e.code === 'INSUFFICIENT_CREDIT');
  console.log('credit-integrity: 複数回の期限切れ・台帳保存則・月境界・旧無制限予約の移行・権限解除を検証');
}
module.exports = { TransactionalFirestore };
if (require.main === module) main().catch(error=>{console.error(error);process.exitCode=1;});
