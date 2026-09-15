const assert = require('assert');
const express = require('express');
const path = require('path');
const { request, listen } = require('./partner_http_helper');
const { createPartnerRouter } = require('../routes/partners');

async function main() {
  const fixture = { mode: 'dashboard', admin: true, user: null, month: '2026-09',
    partners: [], csrf: 'fixture', base: '/admin/mojidas-partners', error: '',
    rows: [{ partnerID: 'test', organizationName: 'テスト', domain: 'example.com',
      website: 'https://example.com', contact: '', status: 'approved',
      usage: { realtime: 0, mediaFile: 3661999, formalTranslation: 360000000 } }] };
  for (const admin of [true, false]) {
    const html = await require('ejs').renderFile(path.join(__dirname, '../views/partners/index.ejs'),
      { ...fixture, admin, user: { name: 'テスト', email: 'test@example.com' } });
    for (const time of ['00:00:00', '01:01:01', '100:00:00', '101:01:01']) {
      assert(html.includes(`<td>${time}</td>`));
    }
    assert(!html.includes('表示単位は時間です'));
    assert.equal(html.includes('data-dialog-open="domain-details-0"'), !admin);
    assert.equal(html.includes('<dialog id="domain-details-0"'), !admin);
  }
  const calls = []; let active = true;
  for (const status of ['approved', 'rejected', 'suspended', 'pending']) {
    const html = await require('ejs').renderFile(path.join(__dirname, '../views/partners/index.ejs'),
      { ...fixture, rows: [{ ...fixture.rows[0], status }] });
    const select = html.match(/<select name="status"[\s\S]*?<\/select>/)[0];
    assert(select.includes(status === 'pending' ? 'value="" selected disabled' : `value="${status}" selected`));
    assert.equal((select.match(/ selected/g) || []).length, 1);
  }
  const store = {
    login: async (email, password) => { assert.equal(password, 'password'); return 'dealer-a'; },
    activePartner: async id => active ? { id, name: '<script>dealer</script>', email: 'dealer@example.com' } : null,
    dashboard: async (id, month) => { calls.push(['dashboard', id, month]); return []; },
    listPartners: async () => [],
    submit: async (id, body) => { calls.push(['submit', id, body.domain]); },
    review: async (...args) => { calls.push(['review', ...args]); },
    invite: async (...args) => { calls.push(['invite', ...args]); },
    updateName: async (...args) => { calls.push(['edit', ...args]); },
    updateDomain: async (id, body) => { calls.push(['domain-edit', id, body.domain]); },
    accept: async (...args) => { calls.push(['accept', ...args]); },
  };
  const app = express(); app.use(express.json());
  app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '../views'));
  app.use(require('../modules/auth/web_sessions').createWebSessions({
    secret: 'isolated-test-session', resave: false, saveUninitialized: false,
  }));
  // 本番には存在しない、隔離された管理者セッションfixture。
  app.get('/fixture-admin', (req, res) => { req.session.adminUser = { email: 'admin@example.com' }; res.send('ok'); });
  app.post('/fixture-admin-logout', (req, res) => req.session.destroy(() => res.send('ok')));
  app.use('/partners', createPartnerRouter({ store }));
  app.use('/admin/mojidas-partners', createPartnerRouter({ store, admin: true }));
  const server = await listen(app);
  const csrf = result => result.text.match(/name="csrfToken" value="([a-f0-9]{64})"/)[1];
  try {
    const login = await request(server, '/partners'); assert.equal(login.status, 200);
    assert.match(login.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(login.headers['cache-control'], 'no-store');
    const cookie = login.cookie;
    const denied = await request(server, '/partners/login', { method: 'POST', cookie, body: { password: 'password' } });
    assert.equal(denied.status, 403);
    const logged = await request(server, '/partners/login', { method: 'POST', cookie,
      body: { csrfToken: csrf(login), email: 'dealer@example.com', password: 'password' } });
    assert.equal(logged.status, 303); assert.notEqual(logged.cookie, cookie);
    const dashboard = await request(server, '/partners?partnerID=dealer-b', { cookie: logged.cookie });
    assert.equal(dashboard.status, 200); assert.match(dashboard.text, /&lt;script&gt;dealer/);
    assert.match(dashboard.text, /data-dialog-open="domain-application"/);
    const application = dashboard.text.match(/<dialog id="domain-application"[\s\S]*?<\/dialog>/)[0];
    assert.match(application, /action="\/partners\/domains"/);
    for (const field of ['organizationName', 'domain', 'csrfToken']) {
      assert(application.includes(`name="${field}"`));
    }
    assert(!application.includes('name="website"'));
    assert(!application.includes('name="contact"'));
    assert.match(application, /type="button" class="secondary" data-dialog-close/);
    assert.equal(calls.at(-1)[1], 'dealer-a');
    const domainEdit = await request(server, '/partners/domains/edit', { method: 'POST', cookie: logged.cookie,
      body: { csrfToken: csrf(dashboard), domain: 'example.co.jp', partnerID: 'dealer-b', month: '2026-08' } });
    assert.equal(domainEdit.status, 303);
    assert.equal(domainEdit.headers.location, '/partners?month=2026-08');
    assert.deepEqual(calls.at(-1), ['domain-edit', 'dealer-a', 'example.co.jp']);
    assert.equal((await request(server, '/partners/domains/edit', { method: 'POST', cookie: logged.cookie,
      body: { domain: 'example.co.jp' } })).status, 403);
    const submit = await request(server, '/partners/domains', { method: 'POST', cookie: logged.cookie,
      body: { csrfToken: csrf(dashboard), domain: 'example.co.jp', partnerID: 'dealer-b' } });
    assert.equal(submit.status, 303); assert.deepEqual(calls.at(-1), ['submit', 'dealer-a', 'example.co.jp']);
    assert.equal((await request(server, '/admin/mojidas-partners', { cookie: logged.cookie })).status, 302);
    assert(!calls.some(call => call[0] === 'dashboard' && call[1] === null));
    active = false;
    const before = calls.length;
    assert.equal((await request(server, '/partners', { cookie: logged.cookie })).status, 200);
    assert.equal(calls.length, before);
    const admin = await request(server, '/fixture-admin');
    active = true;
    const both = `${admin.cookie}; ${logged.cookie}`;
    assert.equal((await request(server, '/partners', { cookie: both })).status, 200);
    const reloginPage = await request(server, '/partners', { cookie: both });
    const relogin = await request(server, '/partners/login', { method: 'POST', cookie: both,
      body: { csrfToken: csrf(reloginPage), email: 'dealer@example.com', password: 'password' } });
    assert.match(relogin.cookie, /^mojidas\.partner\.sid=/);
    const combined = `${admin.cookie}; ${relogin.cookie}`;
    assert.equal((await request(server, '/admin/mojidas-partners', { cookie: combined })).status, 200);
    const partnerPage = await request(server, '/partners', { cookie: combined });
    assert.match(partnerPage.text, /組織のドメインを申請/);
    await request(server, '/partners/logout', { method: 'POST', cookie: combined,
      body: { csrfToken: csrf(partnerPage) } });
    assert.equal((await request(server, '/admin/mojidas-partners', { cookie: combined })).status, 200);
    const partnerLoginPage = await request(server, '/partners', { cookie: combined });
    const again = await request(server, '/partners/login', { method: 'POST', cookie: combined,
      body: { csrfToken: csrf(partnerLoginPage), email: 'dealer@example.com', password: 'password' } });
    const temporaryAdmin = await request(server, '/fixture-admin');
    const separate = `${temporaryAdmin.cookie}; ${again.cookie}`;
    await request(server, '/fixture-admin-logout', { method: 'POST', cookie: separate });
    assert.match((await request(server, '/partners', { cookie: separate })).text, /組織のドメインを申請/);
    const host = 'tools.udtalk.jp';
    const hostPage = await request(server, '/admin/mojidas-partners', { cookie: admin.cookie, host });
    assert.equal(hostPage.status, 200, '既存の管理ホストで管理画面を開ける');
    assert.match(hostPage.text, /<dialog id="partner-invite"/);
    assert.match(hostPage.text, /販売店一覧/);
    const editPath = '/admin/mojidas-partners/edit';
    assert.equal((await request(server, editPath, { method: 'POST', cookie: admin.cookie, host,
      body: { id: 'dealer-a', name: '変更' } })).status, 403);
    assert.equal((await request(server, editPath, { method: 'POST', host,
      body: { id: 'dealer-a', name: '変更' } })).status, 302);
    assert(!calls.some(call => call[0] === 'edit'));
    assert.equal((await request(server, editPath, { method: 'POST', cookie: admin.cookie, host,
      body: { csrfToken: csrf(hostPage), id: 'dealer-a', name: '変更' } })).status, 303);
    assert.deepEqual(calls.at(-1), ['edit', 'dealer-a', '変更']);
    const unauthorized = await request(server, '/admin/mojidas-partners', { host });
    assert.equal(unauthorized.status, 302);
    assert.equal(unauthorized.headers.location, '/admin');
    const rejectedReview = await request(server, '/admin/mojidas-partners/review', {
      method: 'POST', cookie: admin.cookie, host, body: { domain: 'example.co.jp', status: 'approved' } });
    assert.equal(rejectedReview.status, 403, '管理ホストでもCSRFを必須にする');
    const hostReview = await request(server, '/admin/mojidas-partners/review', {
      method: 'POST', cookie: admin.cookie, host,
      body: { csrfToken: csrf(hostPage), domain: 'example.co.jp', status: 'approved' } });
    assert.equal(hostReview.status, 303);
    assert.equal((await request(server, '/partners', { host })).status, 404, '販売店ページのホスト制限は維持');
    assert.equal((await request(server, '/partners', { host: 'app.mojidas.jp' })).status, 200);
    const adminPage = await request(server, '/admin/mojidas-partners', { cookie: admin.cookie });
    assert.equal(adminPage.status, 200); assert.equal(calls.at(-1)[1], null);
    for (const action of ['invite', 'edit', 'review', 'domains/edit']) {
      const result = await request(server, `/admin/mojidas-partners/${action}?month=2026-08`, {
        method: 'POST', cookie: admin.cookie, headers: { 'X-Requested-With': 'MojidasDOM' },
        body: { csrfToken: csrf(adminPage), domain: 'example.co.jp', name: '販売店', status: 'approved' } });
      assert.equal(result.status, 200);
      assert.equal(result.headers.location, undefined);
      assert.match(result.text, /data-admin-dynamic/);
      assert.match(result.text, /value="2026-08"/);
    }
    const review = await request(server, '/admin/mojidas-partners/review', { method: 'POST', cookie: admin.cookie,
      body: { csrfToken: csrf(adminPage), domain: 'example.co.jp', status: 'approved' } });
    assert.equal(review.status, 303);
    assert.deepEqual(calls.at(-1), ['review', 'example.co.jp', 'approved', 'admin@example.com']);
    const accepted = await request(server, '/partners/accept'); assert.equal(accepted.status, 200);
    assert.match(accepted.text, /invite-token/);
    const ajaxHeaders = { 'X-Requested-With': 'MojidasDOM' };
    const ajaxLogin = await request(server, '/partners/login', { method: 'POST', cookie: accepted.cookie,
      headers: ajaxHeaders, body: { csrfToken: csrf(accepted), email: 'dealer@example.com', password: 'password' } });
    assert.equal(ajaxLogin.status, 200);
    assert.match(ajaxLogin.text, /data-partner-dynamic/);
    assert.notEqual(csrf(ajaxLogin), csrf(accepted));
    for (const action of ['domains', 'domains/edit']) {
      const result = await request(server, `/partners/${action}?month=2026-08`, { method: 'POST',
        cookie: ajaxLogin.cookie, headers: ajaxHeaders,
        body: { csrfToken: csrf(ajaxLogin), domain: 'example.co.jp' } });
      assert.equal(result.status, 200);
      assert.equal(result.headers.location, undefined);
      assert.match(result.text, /value="2026-08"/);
    }
    const ajaxLogout = await request(server, '/partners/logout', { method: 'POST', cookie: ajaxLogin.cookie,
      headers: ajaxHeaders, body: { csrfToken: csrf(ajaxLogin) } });
    assert.equal(ajaxLogout.status, 200);
    assert.match(ajaxLogout.text, /action="\/partners\/login"/);
    console.log('販売店画面: ログイン・セッション再生成・CSRF・販売店分離・停止・管理者境界・EJS描画を確認');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
