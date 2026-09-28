const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { FakeFirestore } = require('./mojidas_credit_store.test');
const { CorporatePortalStore } = require('../modules/partners/corporate_portal_store');
const { createAdminPasswordHash } = require('../modules/auth/admin_credentials');
const { createCorporateRouter } = require('../routes/corporate');
const { createWebSessions } = require('../modules/auth/web_sessions');
const { request, listen } = require('./partner_http_helper');
class DB extends FakeFirestore {
  constructor() { super(); this.queue = Promise.resolve(); }
  runTransaction(callback) {
    const task = this.queue.then(async () => {
      const writes = [];
      const result = await callback({ get: ref => ref.get(), update: (ref, data) => writes.push(() => ref.update(data)) });
      if (this.fail) { this.fail = false; throw Error('commit failed'); }
      for (const write of writes) await write();
      return result;
    });
    this.queue = task.catch(() => {}); return task;
  }
}
async function main() {
  const db = new DB(), sent = []; let now = Date.now(), failMail = false;
  const store = new CorporatePortalStore({ firestoreProvider: () => db, now: () => now,
    mailer: { send: async mail => { if (failMail) throw Error('delivery failed'); sent.push(mail); } } });
  const email = 'admin@company.example', id = crypto.createHash('sha256').update(email).digest('hex');
  const ref = store.collection('corporatePortalAccounts').doc(id);
  await ref.set({ email, passwordHash: createAdminPasswordHash('old-password-123'), version: 1, mustChangePassword: false });
  await store.collection('corporateDomains').doc('company.example').set({ portalAccountID: id, custom: 'preserve' });
  const domains = structuredClone(db.records('Mojidas/production/corporateDomains'));
  const login = await store.login(email, 'old-password-123');
  const token = () => sent.at(-1).text.match(/token=([a-f0-9.]+)/)[1];
  await store.requestPasswordReset('absent@company.example'); assert.equal(sent.length, 0);
  await store.requestPasswordReset(email.toUpperCase()); const first = token();
  assert(!(JSON.stringify(db.collections).includes(first.split('.')[1])), '平文トークンは保存しない');
  await store.requestPasswordReset(email); assert.equal(sent.length, 1, '同一アカウントは1分間隔');
  assert(await store.login(email, 'old-password-123'), '申請だけでは変更しない');
  await assert.rejects(store.resetPassword(first, 'short'));
  now += 61000; await store.requestPasswordReset(email); const second = token();
  await assert.rejects(store.resetPassword(first, 'new-password-123'));
  const before = structuredClone(db.collections); db.fail = true;
  await assert.rejects(store.resetPassword(second, 'new-password-123'));
  assert.deepStrictEqual(db.collections, before, '失敗時はトークン・パスワードを保全');
  const concurrent = await Promise.allSettled([store.resetPassword(second, 'new-password-123'), store.resetPassword(second, 'other-password-123')]);
  assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await store.account(login), null, '既存ログイン失効');
  await assert.rejects(store.login(email, 'old-password-123'));
  await store.login(email, 'new-password-123');
  now += 61000; await store.requestPasswordReset(email); const expired = token(); now += 30 * 60000;
  await assert.rejects(store.resetPassword(expired, 'expired-password-123'));
  failMail = true; await assert.rejects(store.requestPasswordReset(email));
  assert.equal((await ref.get()).data().resetHash, null); failMail = false;
  assert.deepStrictEqual(db.records('Mojidas/production/corporateDomains'), domains);

  const app = express(); app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '../views'));
  app.use(express.urlencoded({ extended: false })); app.use(express.json()); app.use(express.static(path.join(__dirname, '../public')));
  app.use(createWebSessions({ secret: 'isolated-reset-test-secret', resave: false, saveUninitialized: false }));
  app.use('/corporate', createCorporateRouter({ store, now: () => now }));
  const server = await listen(app); let cookie, csrf;
  const send = async (url, body) => {
    const r = await request(server, '/corporate' + url, { cookie, method: body ? 'POST' : 'GET', body: body ? { csrfToken: csrf, ...body } : undefined });
    if (r.cookie) cookie = r.cookie;
    const found = r.text.match(/name="csrfToken" value="([a-f0-9]+)"/); if (found) csrf = found[1];
    return r;
  };
  try {
    assert((await send('')).text.includes('パスワードをお忘れの方'));
    await send('/forgot-password');
    assert.equal((await send('/forgot-password', { email, csrfToken: 'bad' })).status, 403);
    const known = await send('/forgot-password', { email });
    const absent = await send('/forgot-password', { email: 'absent@company.example' });
    assert.equal(known.status, absent.status); assert.equal(known.text, absent.text);
    // HTTP申請と切り離してメールリンクを固定し、入力〜更新〜再利用拒否を検証する。
    await new Promise(resolve => setImmediate(resolve)); await db.queue;
    now += 61000; await store.requestPasswordReset(email); const link = token();
    assert.equal((await send('/reset-password?token=' + link)).status, 303);
    const form = await send('/reset-password'); assert(form.text.includes('新しいパスワード')); assert(!form.text.includes(link));
    assert.equal((await send('/reset-password', { password: 'final-password-123', confirmPassword: 'mismatch' })).status, 400);
    const done = await send('/reset-password', { password: 'final-password-123', confirmPassword: 'final-password-123' });
    assert.equal(done.status, 200); assert(done.text.includes('パスワードを再設定しました'));
    await store.login(email, 'final-password-123');
    await send('/reset-password?token=' + link); await send('/reset-password');
    assert.equal((await send('/reset-password', { password: 'reuse-password-123', confirmPassword: 'reuse-password-123' })).status, 400);
  } finally {
    if (process.env.CORPORATE_RESET_PREVIEW === '1') console.log(`隔離プレビュー http://127.0.0.1:${server.address().port}/corporate`);
    else await new Promise(resolve => server.close(resolve));
  }
  console.log('法人再設定: 共通応答・CSRF・期限・一回限り・並行実行・失敗保全・セッション失効・HTTP確認成功');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
