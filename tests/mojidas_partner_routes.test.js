const assert = require('assert');
const express = require('express');
const session = require('express-session');
const path = require('path');
const { request, listen } = require('./partner_http_helper');
const { createPartnerRouter } = require('../routes/partners');

async function main() {
  const calls = []; let active = true;
  const store = {
    login: async (email, password) => { assert.equal(password, 'password'); return 'dealer-a'; },
    activePartner: async id => active ? { id, name: '<script>dealer</script>', email: 'dealer@example.com' } : null,
    dashboard: async (id, month) => { calls.push(['dashboard', id, month]); return []; },
    listPartners: async () => [],
    submit: async (id, body) => { calls.push(['submit', id, body.domain]); },
    review: async (...args) => { calls.push(['review', ...args]); },
    invite: async (...args) => { calls.push(['invite', ...args]); },
    accept: async (...args) => { calls.push(['accept', ...args]); },
  };
  const app = express(); app.use(express.json());
  app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '../views'));
  app.use(session({ secret: 'isolated-test-session', resave: false, saveUninitialized: false }));
  // 本番には存在しない、隔離された管理者セッションfixture。
  app.get('/fixture-admin', (req, res) => { req.session.adminUser = { email: 'admin@example.com' }; res.send('ok'); });
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
    assert.equal(calls.at(-1)[1], 'dealer-a');
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
    const adminPage = await request(server, '/admin/mojidas-partners', { cookie: admin.cookie });
    assert.equal(adminPage.status, 200); assert.equal(calls.at(-1)[1], null);
    const review = await request(server, '/admin/mojidas-partners/review', { method: 'POST', cookie: admin.cookie,
      body: { csrfToken: csrf(adminPage), domain: 'example.co.jp', status: 'approved' } });
    assert.equal(review.status, 303);
    assert.deepEqual(calls.at(-1), ['review', 'example.co.jp', 'approved', 'admin@example.com']);
    const accepted = await request(server, '/partners/accept'); assert.equal(accepted.status, 200);
    assert.match(accepted.text, /invite-token/);
    console.log('販売店画面: ログイン・セッション再生成・CSRF・販売店分離・停止・管理者境界・EJS描画を確認');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
