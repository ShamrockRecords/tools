const assert = require('assert');
const express = require('express');
const path = require('path');
const { request, listen } = require('./partner_http_helper');
const { createPartnerRouter } = require('../routes/partners');

async function main() {
  const fixture = { mode: 'dashboard', admin: true, user: null, month: '2026-09', year: 2026, annualRows: [],
    partners: [], csrf: 'fixture', base: '/admin/mojidas-partners', error: '',
    rows: [{ partnerID: 'test', organizationName: 'テスト', domain: 'example.com',
      website: 'https://example.com', contact: '', status: 'approved',
      usage: { realtime: 0, mediaFile: 3661999, formalTranslation: 360000000 } }] };
  for (const admin of [true, false]) {
    const html = await require('ejs').renderFile(path.join(__dirname, '../views/partners/index.ejs'),
      { ...fixture, admin, base: admin ? '/admin/mojidas-partners' : '/partners', user: { name: 'テスト', email: 'test@example.com' } });
    for (const time of ['00:00:00', '01:01:01', '100:00:00', '101:01:01']) {
      assert(html.includes(`<td>${time}</td>`));
    }
    assert(!html.includes('表示単位は時間です'));
    assert(html.includes('data-dialog-open="domain-details-0"'));
    assert(html.includes('<dialog id="domain-details-0"'));
    const dialog = html.split('<dialog id="domain-details-0"')[1].split('</dialog>')[0];
    assert(dialog.includes(`action="${admin ? '/admin/mojidas-partners' : '/partners'}/domains/edit"`));
    assert(dialog.includes('name="domain" value="example.com"'));
    for (const field of ['organizationName', 'contactEmail', 'notes', 'limitHours', 'resetDay', 'stopAtLimit', 'notifyAtOneHour'])
      assert(dialog.includes(`name="${field}"`));
    assert(dialog.includes('type="button" class="secondary" data-dialog-close'));
  }
  const calls = []; let active = true;
  const dropdownHTML = await require('ejs').renderFile(path.join(__dirname, '../views/partners/index.ejs'),
    { ...fixture, partners: [
      { id: 'active-dealer', name: '<販売店>', email: 'active@example.com', status: 'active' },
      { id: 'invited-dealer', name: '招待中', email: 'invited@example.com', status: 'invited' },
      { id: 'disabled-dealer', name: '無効', email: 'disabled@example.com', status: 'suspended' },
    ] });
  const dealerSelect = dropdownHTML.match(/<select name="partnerID"[\s\S]*?<\/select>/)[0];
  assert(dealerSelect.includes('<option value="active-dealer">&lt;販売店&gt;（active@example.com）</option>'));
  assert(!dealerSelect.includes('invited-dealer'));
  assert(!dealerSelect.includes('disabled-dealer'));
  const annualFixture = [
    { domain: 'a.example', organizationName: '組織A', partnerID: 'test', months: [], total: 0 },
    { domain: 'b.example', organizationName: '組織B', partnerID: 'test', months: [], total: 0 },
  ];
  for (const admin of [true, false]) {
    const annualHTML = await require('ejs').renderFile(path.join(__dirname, '../views/partners/index.ejs'),
      { ...fixture, admin, user: { name: '販売店', email: 'dealer@example.com' }, annualRows: annualFixture });
    assert(annualHTML.includes('<option value="">組織を選択してください</option>'));
    for (const row of annualFixture) {
      assert(annualHTML.includes(`data-annual-domain="${row.domain}" hidden`));
      assert(annualHTML.includes(`<option value="${row.domain}">`));
    }
  }
  // DOM更新のみで切り替え、年変更後も選択を復元し、消えた組織は未選択にする。
  const listeners = {};
  const context = { document: { addEventListener(type, handler) { listeners[type] = handler; }, getElementById() { return null; } } };
  require('vm').createContext(context);
  require('vm').runInContext(require('fs').readFileSync(path.join(__dirname, '../public/javascripts/mojidas-partners.js'), 'utf8'), context);
  let monthSubmissions = 0;
  for (const valid of [false, true]) {
    listeners.change({ target: { matches: selector => selector === '[data-auto-month]',
      checkValidity: () => valid, form: { requestSubmit() { monthSubmissions++; } } } });
    assert.equal(monthSubmissions, valid ? 1 : 0, '有効な対象月への変更だけで更新する');
  }
  const blocks = annualFixture.map(row => ({ dataset: { annualDomain: row.domain }, hidden: true }));
  let selected = '';
  const select = { get value() { return selected; }, set value(value) { selected = annualFixture.some(row => row.domain === value) ? value : ''; } };
  const empty = { hidden: false };
  const mainDOM = { querySelector: key => key === '[data-annual-organization]' ? select : empty, querySelectorAll: () => blocks };
  for (const [value, visibility] of [['', [true, true]], ['a.example', [false, true]], ['b.example', [true, false]], ['missing.example', [true, true]]]) {
    context.updateAnnualOrganization(mainDOM, value);
    assert.deepEqual(blocks.map(row => row.hidden), visibility);
    assert.equal(empty.hidden, !!select.value);
  }
  for (const status of ['approved', 'rejected', 'suspended', 'pending']) {
    for (const admin of [true, false]) {
      const rendered = await require('ejs').renderFile(path.join(__dirname, '../views/partners/index.ejs'),
        { ...fixture, admin, user: { name: '販売店', email: 'dealer@example.com' }, rows: [{ ...fixture.rows[0], status }] });
      const usageTable = rendered.split('<h2>ドメイン別の利用時間</h2>')[1].split('</table>')[0];
      assert(!usageTable.includes('<th>状態</th>'));
      assert(usageTable.includes(`<tr class="domain-usage-row${status === 'approved' ? '' : ' is-inactive'}">`));
      assert.equal((usageTable.match(/<th>/g) || []).length, admin ? 8 : 7);
      assert.equal((usageTable.match(/<td>/g) || []).length, admin ? 8 : 7);
    }
    const html = await require('ejs').renderFile(path.join(__dirname, '../views/partners/index.ejs'),
      { ...fixture, rows: [{ ...fixture.rows[0], status }] });
    const select = html.match(/<select name="status"[\s\S]*?<\/select>/)[0];
    assert(select.includes(`value="${status === 'approved' ? 'active' : 'inactive'}" selected`));
    assert.equal((select.match(/ selected/g) || []).length, 1);
  }
  const store = {
    login: async (email, password) => { assert.equal(password, 'password'); return 'dealer-a'; },
    activePartner: async id => active ? { id, name: '<script>dealer</script>', email: 'dealer@example.com' } : null,
    dashboard: async (id, month) => { calls.push(['dashboard', id, month]); return []; },
    yearlyUsage: async (id, year) => { calls.push(['yearlyUsage', id, year]); return []; },
    listPartners: async () => [],
    addDomain: async (id, body, email) => { calls.push(['add-domain', id, body.domain, email]); },
    setDomainStatus: async (...args) => { calls.push(['status', ...args]); },
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
    assert.doesNotMatch(dashboard.text, /data-dialog-open="domain-application"/);
    const annualPage = await request(server, '/partners?year=2025&partnerID=dealer-b', { cookie: logged.cookie });
    assert.equal(annualPage.status, 200);
    assert.match(annualPage.text, /月別の利用時間 — 2025年/);
    assert.match(annualPage.text, /name="year" value="2024"/);
    assert.match(annualPage.text, /name="year" value="2026"/);
    assert(calls.some(call => call[0] === 'yearlyUsage' && call[1] === 'dealer-a' && call[2] === 2025));
    assert.equal((await request(server, '/partners?year=invalid', { cookie: logged.cookie })).status, 400);
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
    assert.equal(submit.status, 404);
    assert(!calls.some(call => call[0] === 'add-domain'));
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
    assert.match(partnerPage.text, /月別の利用時間/);
    const logout = await request(server, '/partners/logout', { method: 'POST', cookie: combined,
      body: { csrfToken: csrf(partnerPage) } });
    assert.equal((await request(server, '/admin/mojidas-partners', { cookie: combined })).status, 200);
    const partnerLoginPage = await request(server, '/partners', { cookie: `${admin.cookie}; ${logout.cookie}` });
    const again = await request(server, '/partners/login', { method: 'POST', cookie: `${admin.cookie}; ${partnerLoginPage.cookie || logout.cookie}`,
      body: { csrfToken: csrf(partnerLoginPage), email: 'dealer@example.com', password: 'password' } });
    const temporaryAdmin = await request(server, '/fixture-admin');
    const separate = `${temporaryAdmin.cookie}; ${again.cookie}`;
    await request(server, '/fixture-admin-logout', { method: 'POST', cookie: separate });
    assert.match((await request(server, '/partners', { cookie: separate })).text, /月別の利用時間/);
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
    const rejectedReview = await request(server, '/admin/mojidas-partners/domains/status', {
      method: 'POST', cookie: admin.cookie, host, body: { domain: 'example.co.jp', status: 'active' } });
    assert.equal(rejectedReview.status, 403, '管理ホストでもCSRFを必須にする');
    const hostReview = await request(server, '/admin/mojidas-partners/domains/status', {
      method: 'POST', cookie: admin.cookie, host,
      body: { csrfToken: csrf(hostPage), domain: 'example.co.jp', status: 'active' } });
    assert.equal(hostReview.status, 303);
    assert.equal((await request(server, '/partners', { host })).status, 404, '販売店ページのホスト制限は維持');
    assert.equal((await request(server, '/partners', { host: 'app.mojidas.jp' })).status, 200);
    const adminPage = await request(server, '/admin/mojidas-partners', { cookie: admin.cookie });
    assert.equal(adminPage.status, 200); assert.equal(calls.at(-1)[1], null);
    assert.match(adminPage.text, /name="partnerID" required/);
    assert.match(adminPage.text, /法人ドメインを追加/);
    assert.doesNotMatch(adminPage.text, /承認操作|承認を申請/);
    const addPath = '/admin/mojidas-partners/domains';
    assert.equal((await request(server, addPath, { method: 'POST', cookie: logged.cookie,
      body: { csrfToken: csrf(dashboard), partnerID: 'dealer-b', domain: 'example.co.jp' } })).status, 302);
    assert.equal((await request(server, addPath, { method: 'POST', cookie: admin.cookie,
      body: { partnerID: 'dealer-b', domain: 'example.co.jp' } })).status, 403);
    assert.equal((await request(server, addPath, { method: 'POST', cookie: admin.cookie,
      body: { csrfToken: csrf(adminPage), partnerID: 'dealer-b', domain: 'example.co.jp' } })).status, 303);
    assert.deepEqual(calls.at(-1), ['add-domain', 'dealer-b', 'example.co.jp', 'admin@example.com']);
    for (const action of ['invite', 'edit', 'domains', 'domains/status', 'domains/edit']) {
      const result = await request(server, `/admin/mojidas-partners/${action}?month=2026-08`, {
        method: 'POST', cookie: admin.cookie, headers: { 'X-Requested-With': 'MojidasDOM' },
        body: { csrfToken: csrf(adminPage), domain: 'example.co.jp', name: '販売店', status: 'active' } });
      assert.equal(result.status, 200);
      assert.equal(result.headers.location, undefined);
      assert.match(result.text, /data-admin-dynamic/);
      assert.match(result.text, /value="2026-08"/);
      if (action === 'domains/edit') assert(calls.some(call => call[0] === 'domain-edit' && call[1] === null && call[2] === 'example.co.jp'));
    }
    const review = await request(server, '/admin/mojidas-partners/domains/status', { method: 'POST', cookie: admin.cookie,
      body: { csrfToken: csrf(adminPage), domain: 'example.co.jp', status: 'active' } });
    assert.equal(review.status, 303);
    assert.deepEqual(calls.at(-1), ['status', 'example.co.jp', 'active', 'admin@example.com']);
    const accepted = await request(server, '/partners/accept'); assert.equal(accepted.status, 200);
    assert.match(accepted.text, /invite-token/);
    const ajaxHeaders = { 'X-Requested-With': 'MojidasDOM' };
    const ajaxLogin = await request(server, '/partners/login', { method: 'POST', cookie: accepted.cookie,
      headers: ajaxHeaders, body: { csrfToken: csrf(accepted), email: 'dealer@example.com', password: 'password' } });
    assert.equal(ajaxLogin.status, 200);
    assert.match(ajaxLogin.text, /data-partner-dynamic/);
    assert.notEqual(csrf(ajaxLogin), csrf(accepted));
    for (const action of ['domains/edit']) {
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
