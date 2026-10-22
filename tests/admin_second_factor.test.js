const assert = require('assert');
const { AdminChallengeStore, adminActivity, CODE_MS, IDLE_MS } = require('../modules/auth/admin_second_factor');

async function main() {
  let now = Date.now();
  // 同じDBを使う別インスタンスでも一度だけ消費する。
  const records = new Map();
  let queue = Promise.resolve();
  const db = {
    collection() { return { doc: id => ({ id,
      async set(row) { records.set(id, row); }, async delete() { records.delete(id); },
    }) }; },
    runTransaction(fn) {
      const result = queue.then(() => fn({
        get: async ref => ({ exists: records.has(ref.id), data: () => records.get(ref.id) }),
        set: (ref, row) => records.set(ref.id, row), delete: ref => records.delete(ref.id),
      }));
      queue = result.catch(() => {});
      return result;
    },
  };
  for (const persistent of [false, true]) {
    const store = new AdminChallengeStore({ persistent, firestoreProvider: () => db, now: () => now });
    const challenge = await store.create('admin@example.com');
    assert.match(challenge.code, /^\d{6}$/);
    const row = persistent ? records.get(challenge.id) : store.memory.get(challenge.id);
    assert.equal(row.code, undefined);
    assert.notEqual(row.hash, challenge.code);
    const results = await Promise.all([store.consume(challenge.id, challenge.code), store.consume(challenge.id, challenge.code)]);
    assert.equal(results.filter(Boolean).length, 1);
    const expired = await store.create('admin@example.com');
    now += CODE_MS;
    assert.equal(await store.consume(expired.id, expired.code), null);
    const limited = await store.create('admin@example.com');
    const wrong = limited.code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) assert.equal(await store.consume(limited.id, wrong), null);
    assert.equal(await store.consume(limited.id, limited.code), null);
    const removed = await store.create('admin@example.com');
    await store.remove(removed.id);
    assert.equal(await store.consume(removed.id, removed.code), null);
  }
  const req = { session: { cookie: {}, adminUser: { secondFactorVerified: true, lastAccessAt: now } }, app: { locals: { adminAuthNow: () => now } } };
  const res = { set() {} };
  now += IDLE_MS - 1;
  adminActivity(req, res, () => {});
  assert.equal(req.session.adminUser.lastAccessAt, now);
  now += IDLE_MS;
  adminActivity(req, res, () => {});
  assert(!req.session.adminUser);
  req.session.adminUser = { signedInAt: new Date(now).toISOString() };
  adminActivity(req, res, () => {});
  assert(!req.session.adminUser, '既存の1段階認証セッションを無効にする');
  console.log('管理者2段階認証: 一度だけの消費、期限、5回制限、破棄、3日の延長と失効を確認');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
