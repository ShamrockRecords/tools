const assert = require('assert');
const express = require('express');
const path = require('path');
const { FakeFirestore } = require('./mojidas_credit_store.test');
const { PartnerStore } = require('../modules/partners/partner_store');
const { CorporatePortalStore } = require('../modules/partners/corporate_portal_store');
const { createCorporateRouter } = require('../routes/corporate');
const { createWebSessions } = require('../modules/auth/web_sessions');
const { request, listen } = require('./partner_http_helper');

class DB extends FakeFirestore {
  constructor() { super(); this.queue = Promise.resolve(); }
  runTransaction(callback) {
    const task = this.queue.then(async () => {
      let writing = false; const writes = [];
      const result = await callback({
        get: ref => { assert(!writing, 'readはwriteより前'); return ref.get(); },
        set: (ref, data) => { writing = true; writes.push(() => ref.set(data)); },
        update: (ref, data) => { writing = true; writes.push(() => ref.update(data)); },
        delete: ref => { writing = true; writes.push(() => ref.delete()); },
      });
      if (this.fail) { this.fail = false; throw new Error('commit failed'); }
      for (const write of writes) await write();
      return result;
    });
    this.queue = task.catch(() => {}); return task;
  }
}
async function main() {
  const db = new DB(); let now = Date.parse('2026-09-21T00:00:00Z'), failMail = false;
  const sent = [], mailer = { send: async message => { if (failMail) throw Error('mail failed'); sent.push(message); } };
  const options = { firestoreProvider: () => db, now: () => now, mailer, secret: () => 'fixture-only-secret-for-corporate-portal-123456789' };
  const portal = new CorporatePortalStore(options);
  const store = new PartnerStore({ ...options, portalStore: portal });
  const input = { domain: 'company.example', organizationName: '法人A', contactEmail: 'admin@company.example', plan: 'trial', status: 'inactive' };
  await store.collection('creditGrants').doc('personal-fixture').set({ userID: 'personal', remainingMilliseconds: 50000 });
  await store.collection('partners').doc('partner-fixture').set({ email: input.contactEmail, passwordHash: 'separate', status: 'active' });
  const unrelated = [db.records('Mojidas/production/creditGrants'), db.records('Mojidas/production/partners')];
  await store.addDomain('self', input, 'admin');
  assert.equal(sent.length, 0, '無効登録は送らない');
  assert.equal(db.records('Mojidas/production/corporatePortalAccounts').length, 0);
  const before = structuredClone(db.collections);
  await assert.rejects(store.addDomain('self', input, 'admin'), { code: 'DOMAIN_EXISTS' });
  assert.deepStrictEqual(db.collections, before);
  db.fail = true;
  await assert.rejects(store.setDomainStatus(input.domain, 'active', 'admin'), /commit failed/);
  assert.deepStrictEqual(db.collections, before, '失敗時にドメイン・認証情報を保存しない');
  await store.setDomainStatus(input.domain, 'active', 'admin');
  assert.equal(sent.length, 1);
  assert(sent[0].text.includes('https://app.mojidas.jp/corporate'));
  const temporary = sent[0].text.match(/仮パスワード：([^\n]+)/)[1];
  let login = await portal.login(input.contactEmail.toUpperCase(), temporary);
  assert(login.mustChangePassword);
  assert.equal(await portal.account(login), null, '仮パスワードだけでダッシュボード不可');
  assert(!JSON.stringify(db.records('Mojidas/production/corporatePortalAccounts')).includes(temporary));
  const id = login.id;
  await store.setDomainStatus(input.domain, 'inactive', 'admin');
  await store.setDomainStatus(input.domain, 'active', 'admin');
  assert.equal(sent.length, 1, '再有効化で再作成・再送しない');
  assert.equal((await portal.login(input.contactEmail, temporary)).id, id);

  let challenge = await portal.challenge(login);
  let code = sent.at(-1).text.match(/認証コード：(\d{6})/)[1];
  const wrong = code === '000000' ? '000001' : '000000';
  await assert.rejects(portal.changePassword(login, { password: 'new-secure-password', challengeID: challenge }), /メール認証/);
  for (let i = 0; i < 5; i++) await assert.rejects(portal.verifyCode(login, challenge, wrong));
  await assert.rejects(portal.verifyCode(login, challenge, code), /試行回数/);
  await assert.rejects(portal.challenge(login), /1分/);
  now += 60001;
  challenge = await portal.challenge(login); code = sent.at(-1).text.match(/認証コード：(\d{6})/)[1];
  now += 10 * 60000;
  await assert.rejects(portal.verifyCode(login, challenge, code), /期限切れ/);
  challenge = await portal.challenge(login); code = sent.at(-1).text.match(/認証コード：(\d{6})/)[1];
  await portal.verifyCode(login, challenge, code);
  await assert.rejects(portal.verifyCode(login, challenge, code), /認証コード/);
  const oldLogin = login;
  const beforePassword = structuredClone(db.collections);
  db.fail = true;
  await assert.rejects(portal.changePassword(login, { password: 'new-secure-password', challengeID: challenge }), /commit failed/);
  assert.deepStrictEqual(db.collections, beforePassword, '変更失敗ではパスワード・認証コードを保持');
  login = await portal.changePassword(login, { password: 'new-secure-password', challengeID: challenge });
  assert(await portal.account(login));
  assert.equal(await portal.account(oldLogin, true), null);
  await assert.rejects(portal.login(input.contactEmail, temporary));
  assert.equal((await portal.login(input.contactEmail, 'new-secure-password')).mustChangePassword, false);
  await assert.rejects(portal.changePassword(login, { password: 'another-password-123', currentPassword: 'wrong' }));
  login = await portal.changePassword(login, { password: 'another-password-123', currentPassword: 'new-secure-password' });

  await store.addDomain('self', { ...input, domain: 'other.example', contactEmail: 'admin@other.example', status: 'active' }, 'admin');
  assert.deepStrictEqual((await portal.dashboard(login)).map(row => row.domain), [input.domain]);
  await store.addDomain('self', { ...input, domain: 'second.example', status: 'active' }, 'admin');
  assert.equal((await portal.dashboard(login)).length, 2, '同じメールアドレスは既存アカウントに紐付ける');
  await assert.rejects(store.addDomain('self', { ...input, domain: 'no-email.example', contactEmail: '', status: 'active' }, 'admin'), /メールアドレス/);

  failMail = true;
  await assert.rejects(store.addDomain('self', { ...input, domain: 'retry.example', contactEmail: 'admin@retry.example', status: 'active' }, 'admin'), /保存済み/);
  const retryDomain = (await store.collection('corporateDomains').doc('retry.example').get()).data();
  const retryBefore = (await portal.collection('corporatePortalAccounts').doc(retryDomain.portalAccountID).get()).data();
  assert(retryBefore.invitation); assert.equal(retryBefore.invitationStatus, 'failed');
  failMail = false;
  await portal.deliverForDomain('retry.example');
  const retryAfter = (await portal.collection('corporatePortalAccounts').doc(retryDomain.portalAccountID).get()).data();
  assert.equal(retryAfter.passwordHash, retryBefore.passwordHash);
  assert.equal(retryAfter.invitation, null);
  const count = sent.length; await portal.deliverForDomain('retry.example'); assert.equal(sent.length, count);
  const otherTemp = sent.find(mail => mail.to === 'admin@other.example').text.match(/仮パスワード：([^\n]+)/)[1];
  for (let i = 0; i < 5; i++) await assert.rejects(portal.login('admin@other.example', 'wrong'));
  await assert.rejects(portal.login('admin@other.example', otherTemp), /パスワード/);
  now += 15 * 60000;
  assert((await portal.login('admin@other.example', otherTemp)).mustChangePassword);
  assert.deepStrictEqual([db.records('Mojidas/production/creditGrants'), db.records('Mojidas/production/partners')], unrelated);

  // 初回ログインをHTTPで検証。アプリ・販売店・管理者とはCookieと認証ストアを分離する。
  const app = express(); app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '../views'));
  app.use(express.json()); app.use(createWebSessions({ secret: 'isolated-http-session', resave: false, saveUninitialized: false }));
  app.use('/corporate', createCorporateRouter({ store: portal, now: () => now }));
  const server = await listen(app);
  let cookie, csrf;
  const send = async (path, body) => {
    const response = await request(server, `/corporate${path}`, { method: body ? 'POST' : 'GET', cookie, body: body ? { csrfToken: csrf, ...body } : undefined });
    if (response.cookie) cookie = response.cookie;
    const match = response.text.match(/name="csrfToken" value="([a-f0-9]+)"/);
    if (match) csrf = match[1];
    return response;
  };
  try {
    assert.equal((await send('')).status, 200); assert(cookie.startsWith('mojidas.corporate.sid='));
    assert.equal((await send('/login', { email: input.contactEmail, password: 'another-password-123', csrfToken: 'bad' })).status, 403);
    const originalCookie = cookie;
    assert.equal((await send('/login', { email: input.contactEmail, password: 'another-password-123' })).status, 303);
    assert.notEqual(cookie, originalCookie);
    let response = await send(''); assert(response.text.includes('ダッシュボード')); assert(!response.text.includes('other.example'));
    assert((await send('/password')).text.includes('現在のパスワード'));
    assert.equal((await send('/logout', {})).status, 303); await send('');
    const retryTemp = sent.find(mail => mail.to === 'admin@retry.example').text.match(/仮パスワード：([^\n]+)/)[1];
    assert.equal((await send('/login', { email: 'admin@retry.example', password: retryTemp })).status, 303);
    response = await send(''); assert(response.text.includes('メールアドレスの認証')); assert(!response.text.includes('<h2>ダッシュボード'));
    assert.equal((await send('/password', { password: 'verified-password-123', confirmPassword: 'verified-password-123' })).status, 403);
    const currentCode = sent.at(-1).text.match(/認証コード：(\d{6})/)[1];
    assert.equal((await send('/verify', { code: currentCode })).status, 303);
    response = await send(''); assert(response.text.includes('初回パスワードの設定'));
    assert.equal((await send('/password', { password: 'verified-password-123', confirmPassword: 'verified-password-123' })).status, 303);
    response = await send(''); assert(response.text.includes('<h2>ダッシュボード')); assert(!response.text.includes('company.example'));
    assert.equal((await request(server, '/corporate', { host: 'tools.udtalk.jp' })).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('法人ポータル: 有効化・重複保全・失敗再送・初回認証・強制変更・権限分離・HTTPフロー成功');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
