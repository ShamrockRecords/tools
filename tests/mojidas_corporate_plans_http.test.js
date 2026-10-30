const assert = require('assert');
const express = require('express');
const path = require('path');
const { fixture } = require('./mojidas_corporate_billing.test');
const { CorporatePortalStore } = require('../modules/partners/corporate_portal_store');
const { createCorporateRouter } = require('../routes/corporate');
const { createWebSessions } = require('../modules/auth/web_sessions');
const { request, listen } = require('./partner_http_helper');

async function main() {
  const f = await fixture(); f.setTime('2026-10-30T12:00:00+09:00');
  const store = new CorporatePortalStore({ firestoreProvider: () => f.db, now: f.now,
    authProvider: () => ({ listUsers: async () => ({ users: [] }) }) });
  store.billing = f.billing;
  const users = {
    'billing@company.example': { id: 'portal-a', email: 'billing@company.example', mustChangePassword: false },
    'other@other.example': { id: 'other', email: 'other@other.example', mustChangePassword: false },
    'initial@company.example': { id: 'portal-a', email: 'initial@company.example', mustChangePassword: true },
  };
  store.account = async login => users[login?.email] || null;
  store.login = async email => users[email]; store.challenge = async () => 'fixture';
  const app = express(); app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '../views'));
  app.use(express.urlencoded({ extended: false })); app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));
  app.use(createWebSessions({ secret: 'isolated-plan-test-session-only', resave: false, saveUninitialized: false }));
  app.use('/corporate', createCorporateRouter({ store, now: f.now }));
  const server = await listen(app);
  const csrf = page => page.text.match(/name="csrfToken" value="([a-f0-9]+)"/)[1];
  async function login(email) {
    const page = await request(server, '/corporate');
    const result = await request(server, '/corporate/login', { method: 'POST', cookie: page.cookie,
      body: { email, password: 'isolated-test', csrfToken: csrf(page) } });
    assert.equal(result.status, 303); return result.cookie;
  }
  const ref = f.col('corporateDomains').doc(f.row.domain);
  try {
    const cookie = await login('billing@company.example');
    const page = await request(server, '/corporate', { cookie });
    assert.equal(page.status, 200); assert(page.text.includes('今月（10月）のプラン'));
    assert(page.text.includes('来月（11月）からのプラン')); assert(page.text.includes('13,200円'));
    assert(page.text.includes('月50時間')); assert(page.text.includes('data-plan-form hidden'));
    const body = { csrfToken: csrf(page), domain: f.row.domain, month: '2026-11', version: '0', plan: 'standard', contract: f.id };
    const post = (b = body, c = cookie) => request(server, '/corporate/plan', { cookie: c, method: 'POST', body: b });
    const before = structuredClone(f.db.contents());
    assert.equal((await post({ ...body, csrfToken: '0'.repeat(64) })).status, 403);
    for (const email of ['other@other.example', 'initial@company.example']) {
      const otherCookie = await login(email), otherPage = await request(server, '/corporate', { cookie: otherCookie });
      assert.equal((await post({ ...body, csrfToken: csrf(otherPage) }, otherCookie)).status, email.startsWith('initial') ? 403 : 400);
    }
    assert.deepStrictEqual(f.db.contents(), before, 'CSRF・他社・初回設定中は契約を書き換えない');
    f.db.failCommit = true;
    const failed = await post(); assert.equal(failed.status, 400); assert(failed.text.includes('変更を保存できませんでした'));
    assert.equal((await ref.get()).data().pendingPlanChange, undefined);
    assert.equal((await post()).status, 303);
    let result = await request(server, '/corporate', { cookie });
    assert(result.text.includes('来月からのプランを保存しました')); assert(result.text.includes('変更予約済み'));
    assert.equal((await ref.get()).data().plan, 'light');
    assert.equal((await ref.get()).data().pendingPlanChange.plan, 'standard');
    const conflict = await post({ ...body, plan: 'metered' });
    assert.equal(conflict.status, 400); assert(conflict.text.includes('別の画面で'));
    assert.equal((await post({ ...body, version: '1', plan: 'light' })).status, 303);
    assert.equal((await ref.get()).data().pendingPlanChange, null);
    assert.equal((await post({ ...body, version: '2' })).status, 303);
    f.setTime('2026-11-01T00:00:00+09:00');
    const stale = await post({ ...body, version: '3', plan: 'metered' });
    assert.equal(stale.status, 400); assert(stale.text.includes('月が替わりました'));
    result = await request(server, '/corporate', { cookie });
    assert(result.text.includes('今月（11月）のプラン')); assert(result.text.includes('来月（12月）からのプラン'));
    assert.equal((await ref.get()).data().plan, 'standard');
    assert(result.text.includes('24,200円')); assert(result.text.includes('月100時間'));
    await ref.update({ organizationName: '<script>alert(1)</script>' });
    result = await request(server, '/corporate', { cookie });
    assert(!result.text.includes('<script>alert(1)</script>')); assert(result.text.includes('&lt;script&gt;'));
    await ref.update({ organizationName: '株式会社サンプル', plan: 'standard' });
    if (process.env.CORPORATE_PLANS_PREVIEW === '1') {
      console.log(`隔離プレビュー: http://127.0.0.1:${server.address().port}/corporate （billing@company.example / 任意のダミーパスワード）`);
    }
  } finally {
    if (process.env.CORPORATE_PLANS_PREVIEW !== '1') await new Promise(resolve => server.close(resolve));
  }
  console.log('法人プランHTTP: 表示・CSRF・認証/所有権・保存失敗・更新/取消・古い画面・XSS 成功');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
