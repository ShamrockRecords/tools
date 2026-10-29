const assert = require('assert');
const express = require('express');
const path = require('path');
const { fixture } = require('./mojidas_corporate_billing.test');
const { createCorporateRouter } = require('../routes/corporate');
const { createWebSessions } = require('../modules/auth/web_sessions');
const { MojidasStripeBillingService, createStripeWebhookHandler } = require('../modules/billing/mojidas_stripe_billing');
const { request, listen } = require('./partner_http_helper');

async function main() {
  const f = await fixture('light', '2026-10-16T10:00:00+09:00');
  f.setTime('2026-11-01T00:05:00+09:00');
  await f.billing.run({ execute: true });
  const id = `${f.id}_2026-10`, invoice = [...f.stripe.records.values()][0];
  const users = {
    'billing@company.example': { id: 'portal-a', email: 'billing@company.example', mustChangePassword: false },
    'other@other.example': { id: 'portal-other', email: 'other@other.example', mustChangePassword: false },
    'initial@other.example': { id: 'portal-a', email: 'initial@other.example', mustChangePassword: true },
  };
  const app = express(); app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '../views'));
  const secret = 'whsec_isolated_fixture';
  f.stripe.webhooks = new (require('stripe'))('sk_test_isolated_fixture').webhooks;
  const bridge = new MojidasStripeBillingService({ stripeClient: f.stripe, corporateBillingService: f.billing,
    environment: { STRIPE_WEBHOOK_SECRET: secret } });
  const webhook = '/api/mojidas/billing/stripe/webhook';
  app.post(webhook, express.raw({ type: 'application/json' }), createStripeWebhookHandler({ billingService: bridge }));
  app.use(express.json()); app.use(express.urlencoded({ extended: false }));
  app.use(express.static(path.join(__dirname, '../public')));
  app.use(createWebSessions({ secret: 'corporate-billing-isolated-test', resave: false, saveUninitialized: false }));
  const store = { billing: f.billing, account: async login => users[login?.email] || null,
    login: async email => users[email], challenge: async () => 'isolated-challenge',
    dashboard: async user => user.id === 'portal-a' ? [{ ...f.row, status: 'active' }] : [] };
  app.use('/corporate', createCorporateRouter({ store, now: f.now }));
  const server = await listen(app);
  const entry = `/corporate/invoices/${id}`;
  async function login(email) {
    const page = await request(server, '/corporate');
    const csrfToken = page.text.match(/name="csrfToken" value="([a-f0-9]+)"/)[1];
    const result = await request(server, '/corporate/login', { method: 'POST', cookie: page.cookie,
      body: { email, password: 'isolated-fixture-password', csrfToken } });
    assert.equal(result.status, 303); return result.cookie;
  }
  try {
    assert.equal((await request(server, entry + '/pdf')).status, 403);
    const cookie = await login('billing@company.example');
    const page = await request(server, '/corporate', { cookie });
    assert.equal(page.status, 200); assert(page.text.includes('請求履歴'));
    assert(page.text.includes('6,812円')); assert(page.text.includes('2026/11/30'));
    assert(page.text.includes('未払い')); assert(page.text.includes('カードで支払う'));
    assert.equal(page.headers['cache-control'], 'no-store');
    for (const kind of ['pdf', 'pay']) {
      const result = await request(server, entry + '/' + kind, { cookie });
      assert.equal(result.status, 303);
      assert.equal(result.headers.location, kind === 'pdf' ? invoice.invoice_pdf : invoice.hosted_invoice_url);
    }
    assert.equal((await request(server, entry + '/wrong', { cookie })).status, 403);
    const other = await login('other@other.example');
    assert(!(await request(server, '/corporate', { cookie: other })).text.includes('TEST-in_1'));
    assert.equal((await request(server, entry + '/pdf', { cookie: other })).status, 404);
    const initial = await login('initial@other.example');
    assert.equal((await request(server, entry + '/pdf', { cookie: initial })).status, 403);
    f.setTime('2026-12-01T00:05:00+09:00');
    // 30日セッションの期限と請求期限は独立して確認する。
    const renewed = await login('billing@company.example');
    assert((await request(server, '/corporate', { cookie: renewed })).text.includes('支払期限超過'));
    invoice.status = 'paid'; invoice.status_transitions.paid_at = Math.floor(f.now() / 1000);
    const event = { id: 'evt_fixture_paid', type: 'invoice.paid', data: { object: invoice } };
    assert.equal((await request(server, webhook, { method: 'POST', body: event,
      headers: { 'Stripe-Signature': 'forged' } })).status, 400);
    assert.equal((await f.billing.history(users['billing@company.example']))[0].state, 'overdue');
    const signature = f.stripe.webhooks.generateTestHeaderString({ payload: JSON.stringify(event), secret });
    for (let retry = 0; retry < 2; retry++) assert.equal((await request(server, webhook, {
      method: 'POST', body: event, headers: { 'Stripe-Signature': signature },
    })).status, 200);
    const paid = await request(server, '/corporate', { cookie: renewed });
    assert(paid.text.includes('支払済み')); assert(!paid.text.includes('カードで支払う'));
    assert(paid.text.includes('請求書PDF'));
    // 表示用文字列のエスケープとリンク障害をHTTPの入口から検証する。
    const ref = f.col('corporateInvoices').doc(id);
    await ref.update({ organizationName: '<script>alert(1)</script>' });
    const escaped = await request(server, '/corporate', { cookie: renewed });
    assert(!escaped.text.includes('<script>alert(1)</script>')); assert(escaped.text.includes('&lt;script&gt;'));
    invoice.invoice_pdf = 'https://evil.example/bill';
    assert.equal((await request(server, entry + '/pdf', { cookie: renewed })).status, 503);
    await ref.update({ organizationName: f.row.organizationName });
    invoice.invoice_pdf = 'https://pay.stripe.com/invoice/in_1/pdf';
    if (process.env.CORPORATE_BILLING_PREVIEW === '1') {
      // 表示確認専用。外部Stripe、Firestore、メールには接続しない。
      invoice.status = 'open'; await ref.update({ state: 'open', paidAt: null });
      console.log(`隔離プレビュー: http://127.0.0.1:${server.address().port}/corporate （billing@company.example / 任意のダミーパスワード）`);
    }
  } finally {
    if (process.env.CORPORATE_BILLING_PREVIEW !== '1') await new Promise(resolve => server.close(resolve));
  }
  console.log('法人請求HTTP: ログイン・他社/初回認証拒否・履歴・期限超過・支払済み・PDF/支払リンク・XSS・障害表示成功');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
