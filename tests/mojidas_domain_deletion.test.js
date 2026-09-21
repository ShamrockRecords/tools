const assert = require('assert');
const { PartnerStore } = require('../modules/partners/partner_store');
const { mojidasCollection } = require('../modules/mojidas_firestore');
const { reset } = require('../scripts/reset_mojidas_corporate_usage');
// 外部接続なし。全書き込みをcommitまで保留し、失敗と再送を検証する。
class DB {
  constructor() { this.rows = new Map(); this.queue = Promise.resolve(); }
  collection(path) {
    const db = this;
    const query = filters => ({
      where: (key, op, value) => { assert.equal(op, '=='); return query([...filters, [key, value]]); },
      get: async () => { const docs = [...db.rows].filter(([key, value]) => key.startsWith(path + '/') && key.split('/').length === path.split('/').length + 1 && filters.every(([field, wanted]) => field.split('.').reduce((v, k) => v?.[k], value) === wanted)).map(([key]) => snapshot(key)); return { docs, size: docs.length }; },
    });
    const snapshot = key => ({ id: key.split('/').pop(), ref: ref(key), exists: db.rows.has(key), data: () => structuredClone(db.rows.get(key)) });
    const ref = key => ({ path: key, id: key.split('/').pop(), get: async () => snapshot(key), collection: name => db.collection(key + '/' + name) });
    return { ...query([]), doc: id => ref(path + '/' + id) };
  }
  runTransaction(callback) {
    const task = this.queue.then(async () => {
      const writes = [];
      const result = await callback({ get: query => { assert.equal(writes.length, 0); return query.get(); },
        create: (ref, data) => { assert(!this.rows.has(ref.path)); writes.push(() => this.rows.set(ref.path, data)); },
        update: (ref, data) => writes.push(() => this.rows.set(ref.path, { ...this.rows.get(ref.path), ...data })),
        delete: ref => writes.push(() => this.rows.delete(ref.path)),
      });
      if (this.fail) { this.fail = false; throw new Error('commit failed'); }
      writes.forEach(write => write()); return result;
    });
    this.queue = task.catch(() => {}); return task;
  }
}
async function main() {
  const db = new DB(), store = new PartnerStore({ firestoreProvider: () => db, portalStore: null });
  const ref = (name, id) => mojidasCollection(db, name).doc(id);
  const put = (name, id, data) => db.rows.set(ref(name, id).path, data);
  const domain = 'delete.example.org';
  put('corporateDomains', domain, { domain, status: 'approved', notes: '保持' });
  await assert.rejects(store.deleteDomain(domain), { code: 'DOMAIN_ACTIVE' });
  put('corporateDomains', domain, { domain, status: 'suspended', notes: '保持' });
  put('corporateUsageLedger', 'old', { domain, milliseconds: 1 });
  await assert.rejects(store.deleteDomain(domain), { code: 'DOMAIN_IN_USE' });
  put('corporateUsageMonths', 'month', { domain, realtime: 1 });
  put('corporateReservations', 'expired', { corporate: { domain }, status: 'consuming', leaseExpiresAt: new Date(0) });
  put('creditGrants', 'personal', { amount: 100 });
  const before = structuredClone([...db.rows]);
  assert.equal((await reset(db)).applied, false); assert.deepEqual([...db.rows], before);
  db.fail = true; await assert.rejects(reset(db, true), /commit failed/); assert.deepEqual([...db.rows], before);
  await reset(db, true);
  assert.equal((await ref('corporateReservations', 'expired').get()).data().status, 'cancelled');
  assert.equal((await ref('corporateUsageLedger', 'old').get()).exists, false);
  assert.equal((await ref('creditGrants', 'personal').get()).data().amount, 100);
  assert.equal((await reset(db, true)).alreadyApplied, true);
  put('corporateReservations', 'current', { corporate: { domain }, status: 'held' });
  await assert.rejects(store.deleteDomain(domain), { code: 'DOMAIN_IN_USE' });
  db.rows.delete(ref('corporateReservations', 'current').path);
  db.fail = true; await assert.rejects(store.deleteDomain(domain), /commit failed/);
  assert.equal((await ref('corporateDomains', domain).get()).data().notes, '保持');
  await store.deleteDomain(domain);
  assert.equal((await ref('corporateDomains', domain).get()).exists, false);
  console.log('法人実績リセット・無効かつ全期間ゼロの削除・未精算拒否・失敗保全・再送テスト成功');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
