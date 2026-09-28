const assert = require('assert');
const express = require('express');
const path = require('path');
const { FakeFirestore } = require('./mojidas_credit_store.test');
const { CorporateManagementStore, estimate } = require('../modules/partners/corporate_management_store');
const { PartnerStore } = require('../modules/partners/partner_store');
const { CorporateUsageStore } = require('../modules/partners/corporate_usage_store');
const { createCorporateRouter } = require('../routes/corporate');
const { createWebSessions } = require('../modules/auth/web_sessions');
const { request, listen } = require('./partner_http_helper');

class DB extends FakeFirestore {
  constructor() { super(); this.queue = Promise.resolve(); }
  runTransaction(callback) {
    const task = this.queue.then(async () => {
      const writes = []; let writing = false;
      const result = await callback({ get: ref => { assert(!writing); return ref.get(); },
        set: (ref, ...args) => { writing = true; writes.push(() => ref.set(...args)); },
        update: (ref, ...args) => { writing = true; writes.push(() => ref.update(...args)); } });
      if (this.fail) { this.fail = false; throw Error('commit failed'); }
      for (const write of writes) await write();
      return result;
    });
    this.queue = task.catch(() => {}); return task;
  }
}
async function main() {
  const db = new DB(), HOUR = 3600000, now = Date.parse('2026-09-29T00:00:00Z');
  const users = [{ uid: 'a', email: 'a@company.example', emailVerified: true },
    { uid: 'b', email: 'b@company.example', emailVerified: true },
    { uid: 'other', email: 'x@other.example', emailVerified: true }];
  const auth = { listUsers: async () => ({ users }), getUser: async uid => { const u = users.find(u => u.uid === uid); if (!u) throw Error('not found'); return u; } };
  const options = { firestoreProvider: () => db, now: () => now, authProvider: () => auth };
  const management = new CorporateManagementStore(options), partner = new PartnerStore({ ...options, portalStore: null });
  const usage = new CorporateUsageStore(options), login = { id: 'portal', mustChangePassword: false }, domain = 'company.example';
  const col = name => management.collection(name);
  await col('corporateDomains').doc(domain).set({ portalAccountID: login.id, domain, organizationName: 'テスト法人', partnerID: 'self', plan: 'light', status: 'approved', limitMilliseconds: 50 * HOUR });
  await col('corporateDomains').doc('other.example').set({ portalAccountID: 'other-portal', domain: 'other.example', partnerID: 'self', plan: 'standard' });
  await col('creditGrants').doc('personal').set({ userID: 'a', remainingMilliseconds: 123456 });
  assert(await partner.entitlement(users[0]), '旧設定の初期値は自動有効');
  await management.policy(login, { domain, mode: 'manual' });
  assert(await partner.entitlement({ id: 'a', email: users[0].email, emailVerified: true }), '設定変更後も既存の状態を維持。ログインAPIのidも扱う');
  assert.equal(await partner.entitlement(users[1]), null, '新規メンバーは自動有効オフなら無効');
  await management.policy(login, { domain, mode: 'auto' });
  assert.equal(await partner.entitlement(users[1]), null, '再ログインで初期状態を上書きしない');
  await management.setMembers(login, { domain, userIDs: ['a', 'b'], action: 'enable' });
  assert(await partner.entitlement(users[0]));
  assert(await partner.entitlement(users[1]));
  await management.setMembers(login, { domain, userIDs: 'b', action: 'disable' });
  assert.equal(await partner.entitlement(users[1]), null);
  await management.policy(login, { domain, mode: 'auto' });
  assert.equal(await partner.entitlement(users[1]), null, '個別の無効が自動設定より優先');
  const before = structuredClone(db.collections);
  for (const input of [{ domain: 'other.example', userIDs: 'other', action: 'enable' },
    { domain, userIDs: ['a', 'other'], action: 'disable' }, { domain, userIDs: [], action: 'disable' },
    { domain, userIDs: 'a', action: 'wrong' }]) await assert.rejects(management.setMembers(login, input));
  await assert.rejects(management.policy(login, { domain: 'other.example', mode: 'manual' }));
  await assert.rejects(management.overview(login, { domain: 'other.example' }));
  await assert.rejects(management.setMembers({ ...login, mustChangePassword: true }, { domain, userIDs: 'a', action: 'disable' }));
  assert.deepStrictEqual(db.collections, before, '不正操作で一部だけ保存しない');
  db.fail = true;
  await assert.rejects(management.setMembers(login, { domain, userIDs: ['a', 'b'], action: 'disable' }));
  assert.deepStrictEqual(db.collections, before, '失敗した一括操作は全件保全');
  await management.setMembers(login, { domain, userIDs: ['a', 'b'], action: 'enable' });
  await management.setMembers(login, { domain, userIDs: ['a', 'b'], action: 'enable' });
  assert.equal(col('corporateMembers') && db.records('Mojidas/production/corporateMembers').length, 2);

  // 無効化しても開始済みの課金区分を変更せず、確定分は法人として残す。
  const corporate = { domain, partnerID: 'self' };
  const args = { corporate, userID: 'a', recognitionRunID: 'run', clientSessionID: 'session', operation: 'realtime', requestedMilliseconds: 0, trackCount: 1 };
  const reservation = await usage.create(args, corporate);
  await management.setMembers(login, { domain, userIDs: 'a', action: 'disable' });
  await assert.rejects(usage.create({ ...args, recognitionRunID: 'new' }, corporate), { code: 'CORPORATE_DISABLED' });
  await assert.rejects(usage.create(args, corporate), { code: 'CORPORATE_DISABLED' });
  await assert.rejects(usage.assertActive({ userID: 'a', reservationID: reservation.id }), { code: 'CORPORATE_DISABLED' });
  await assert.rejects(usage.settle({ userID: 'a', reservationID: reservation.id, sequence: 1, consumedMilliseconds: 60000 }, false), { code: 'CORPORATE_DISABLED' });
  await usage.settle({ userID: 'a', reservationID: reservation.id, consumedMilliseconds: 60000 }, true);
  assert.equal((await col('creditGrants').doc('personal').get()).data().remainingMilliseconds, 123456);
  assert.equal(users[0].disabled, undefined, 'ログイン用Auth情報を変更しない');
  await col('corporateUsageLedger').doc('old').set({ domain, reservationID: 'old-reservation', operation: 'mediaFile', milliseconds: 51 * HOUR, occurredAt: new Date('2026-09-10') });
  await col('corporateReservations').doc('old-reservation').set({ userID: 'b', corporate });
  await col('corporateUsageLedger').doc('august').set({ domain, userID: 'b', operation: 'mediaFile', milliseconds: HOUR, occurredAt: new Date('2026-08-10') });
  const overview = await management.overview(login, { domain, month: '2026-09', q: 'b@' });
  assert.equal(overview.quota.usedMilliseconds, 51 * HOUR + 60000);
  assert.equal(overview.users.length, 1); assert.equal(overview.users[0].uid, 'b');
  assert.equal(overview.users[0].used, 51 * HOUR, '旧台帳を予約のuserIDで集計');
  assert.equal(overview.estimate.total, 13200 + 61 * 5.5);
  assert.equal(estimate('trial', HOUR).total, 0); assert.equal(estimate('custom', HOUR).total, null);
  assert.equal(estimate('metered', 1).total, 2205.5);
  assert.equal((await management.overview(login, { domain, month: '2026-08' })).quota.usedMilliseconds, HOUR);
  assert.equal((await management.overview(login, { domain, q: 'x@other' })).matches, 0);
  for (let i = 0; i < 55; i++) users.push({ uid: `extra-${i}`, email: `extra-${i}@company.example` });
  assert.equal((await management.overview(login, { domain })).users.length, 50);
  assert.equal((await management.overview(login, { domain, page: '2' })).users.length, 7);
  await management.policy(login, { domain, mode: 'manual' });
  assert((await management.overview(login, { domain })).users.find(u => u.uid === 'extra-0').enabled, '一覧の既存アカウントは設定変更で変わらない');
  users.push({ uid: 'new-disabled', email: 'new@company.example', emailVerified: true });
  assert.equal((await management.overview(login, { domain, q: 'new@' })).users[0].enabled, false, '新規作成アカウントも無効で一覧に追加');
  await management.policy(login, { domain, mode: 'auto' });
  assert.equal((await management.overview(login, { domain, q: 'new@' })).users[0].enabled, false);
  await col('corporateDomains').doc(domain).update({ plan: 'trial', hasValidityPeriod: true, validityStartsAt: Date.parse('2026-08-01'), validityEndsAt: Date.parse('2026-10-01') });
  assert.equal((await management.overview(login, { domain })).quota.usedMilliseconds, 52 * HOUR + 60000);
  assert.equal((await management.overview(login, { domain })).estimate.total, 0);

  // セッション・CSRF・初回認証とHTMLフォームの入口から確認する。
  const app = express(); app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '../views'));
  app.use(express.json()); app.use(express.urlencoded({ extended: false }));
  app.use(express.static(path.join(__dirname, '../public')));
  app.use(createWebSessions({ secret: 'corporate-test-fixture', resave: false, saveUninitialized: false }));
  const store = { management, account: async value => value?.id === login.id ? login : null,
    login: async () => login, dashboard: async () => [{ domain, organizationName: 'テスト法人', plan: 'trial', status: 'active' }] };
  app.use('/corporate', createCorporateRouter({ store, now: () => now }));
  const server = await listen(app); let cookie, csrf;
  const send = async (url, body) => {
    const r = await request(server, '/corporate' + url, { cookie, method: body ? 'POST' : 'GET', body: body ? { csrfToken: csrf, ...body } : undefined });
    if (r.cookie) cookie = r.cookie;
    const found = r.text.match(/name="csrfToken" value="([a-f0-9]+)"/); if (found) csrf = found[1]; return r;
  };
  try {
    await send('');
    assert.equal((await send('/members', { domain, userIDs: 'b', action: 'disable' })).status, 403);
    await send('/login', {}); const page = await send('');
    assert.equal(page.status, 200); assert(page.text.includes('アカウント一覧')); assert(!page.text.includes('x@other.example'));
    assert.equal((await send('/members', { csrfToken: 'bad', domain, userIDs: 'b', action: 'disable' })).status, 403);
    assert.equal((await send('/members', { domain: 'other.example', userIDs: 'other', action: 'disable' })).status, 400);
    assert.equal((await send('/members', { domain, userIDs: 'b', action: 'disable' })).status, 303);
    assert.equal(await partner.entitlement(users[1]), null);
    assert.equal((await send('/member-policy', { domain, mode: 'manual' })).status, 303);
    const savePolicy = mode => request(server, '/corporate/member-policy', { method: 'POST', cookie,
      headers: { Accept: 'application/json' }, body: { csrfToken: csrf, domain, mode } });
    assert.deepStrictEqual((await savePolicy('auto')).body, { autoEnable: true });
    db.fail = true;
    assert.equal((await savePolicy('manual')).status, 400);
    assert.equal((await col('corporateDomains').doc(domain).get()).data().autoEnableMembers, true, '保存失敗で設定を変更しない');
    assert.deepStrictEqual((await savePolicy('manual')).body, { autoEnable: false });
    assert(page.text.includes('data-auto-enable'));
    assert.equal((await send('?domain=other.example')).status, 400);
    assert((await send('?q=b%40')).text.includes('b@company.example'));
  } finally {
    if (process.env.CORPORATE_PREVIEW === '1') console.log(`隔離プレビュー: http://127.0.0.1:${server.address().port}/corporate （任意のダミー認証情報でログイン）`);
    else await new Promise(resolve => server.close(resolve));
  }
  console.log('法人アカウント管理: 個別・一括・検索・権限・失敗保全・法人判定・精算・利用集計・概算・HTTP成功');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
