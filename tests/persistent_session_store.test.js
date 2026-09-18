const assert = require('assert');
const { PersistentSessionStore, LOGIN_DURATION_MS } = require('../modules/auth/persistent_session_store');

async function main() {
  const records = new Map();
  let now = Date.parse('2026-09-18T00:00:00Z');
  let fail = false;
  const firestoreProvider = () => ({ collection(path) {
    assert.strictEqual(path, 'Mojidas/production/webSessions');
    return { doc(id) {
      assert(!id.includes('secret-session'));
      return {
        async get() { if (fail) throw Error('read failure'); return { exists: records.has(id), data: () => records.get(id) }; },
        async set(value) { if (fail) throw Error('write failure'); records.set(id, value); },
        async delete() { if (fail) throw Error('delete failure'); records.delete(id); },
      };
    } };
  } });
  const make = scope => new PersistentSessionStore({ scope, firestoreProvider, now: () => now });
  const call = (store, method, ...args) => new Promise((resolve, reject) => store[method](...args, (error, value) => error ? reject(error) : resolve(value)));
  const admin = make('admin');
  const partner = make('partner');
  const original = { cookie: { expires: new Date(now + LOGIN_DURATION_MS).toISOString() },
    adminUser: { email: 'fixture@example.invalid', signedInAt: new Date(now).toISOString() }, adminCSRFToken: 'fixture-csrf' };
  await call(admin, 'set', 'secret-session', original);
  // 別プロセス相当のストアでも復元し、管理者・販売店を混同しない。
  assert.deepStrictEqual(await call(make('admin'), 'get', 'secret-session'), original);
  assert.strictEqual(await call(partner, 'get', 'secret-session'), null);
  const partnerData = { cookie: original.cookie, partnerLogin: { id: 'partner-fixture', at: now } };
  await call(partner, 'set', 'secret-session', partnerData);
  assert.deepStrictEqual(await call(make('partner'), 'get', 'secret-session'), partnerData);
  await call(admin, 'destroy', 'secret-session');
  assert.strictEqual(await call(make('admin'), 'get', 'secret-session'), null);
  assert.deepStrictEqual(await call(partner, 'get', 'secret-session'), partnerData);
  // 読み取りアクセスでは延長せず、Cookieの期限もサーバー側で検査する。
  now += LOGIN_DURATION_MS - 1;
  await call(partner, 'touch', 'secret-session', partnerData);
  assert(await call(partner, 'get', 'secret-session'));
  now++;
  assert.strictEqual(await call(partner, 'get', 'secret-session'), null);
  // 認証の絶対期限を超えてCookieだけ延長しても復活しない。
  await call(partner, 'set', 'secret-session', { ...partnerData, cookie: { expires: new Date(now + LOGIN_DURATION_MS).toISOString() } });
  assert.strictEqual(await call(partner, 'get', 'secret-session'), null);
  fail = true;
  await assert.rejects(call(admin, 'get', 'secret-session'), /read failure/);
  await assert.rejects(call(admin, 'set', 'secret-session', original), /write failure/);
  await assert.rejects(call(admin, 'destroy', 'secret-session'), /delete failure/);
  console.log('永続セッション: 再起動・OS非依存の復元、権限分離、削除、期限、障害を検証');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
