const assert = require('assert');
const express = require('express');
const path = require('path');
const { MojidasCorporateInvoiceStore } = require('../modules/billing/mojidas_corporate_invoice_store');
const { mojidasCollectionPath } = require('../modules/mojidas_firestore');
const { adminActivity, IDLE_MS } = require('../modules/auth/admin_second_factor');
const { request, listen } = require('./partner_http_helper');

async function main() {
  let clock = Date.parse('2026-11-01T00:05:00+09:00'), failed = false, reads = 0, preview = false;
  const base = { month: '2026-10', organizationName: '株式会社サンプル', domain: 'sample.example',
    email: 'billing@sample.example', plan: 'light', number: 'MOJI-2026-001', totalJPY: 13200,
    issuedAt: Date.parse('2026-11-01T00:00:00+09:00'), dueAt: Date.parse('2026-11-30T23:59:59+09:00'),
    paidAt: null, state: 'open', pdfURL: 'https://pay.stripe.com/invoice/fixture/pdf' };
  const invoice = (id, patch = {}) => ({ id, ...base, ...patch });
  const examples = [
    invoice('light'),
    invoice('paid', { organizationName: 'みらい研究所', domain: 'mirai.example', email: 'office@mirai.example',
      plan: 'standard', totalJPY: 24200, number: 'MOJI-2026-002', state: 'paid', paidAt: clock - 60000 }),
    invoice('late', { month: '2026-09', organizationName: '青空デザイン', domain: 'aozora.example', email: 'billing@aozora.example',
      plan: 'metered', totalJPY: 3850, number: 'MOJI-2026-003', issuedAt: base.issuedAt - 86400000 * 31, dueAt: base.issuedAt - 1000 }),
    invoice('void', { organizationName: '株式会社サンプル', number: 'MOJI-2026-004', state: 'void', totalJPY: 0 }),
    invoice('uncollectible', { organizationName: '星野企画', domain: 'hoshino.example', email: 'office@hoshino.example',
      number: 'MOJI-2026-005', state: 'uncollectible', pdfURL: 'javascript:alert(1)' }),
  ];
  let rows = [
    ...examples, invoice('unissued', { issuedAt: null, state: 'pending', number: 'NOT-ISSUED' }),
    invoice('legacy', { issuedAt: new Date(base.issuedAt - 1000), totalJPY: null, plan: '', terms: { plan: 'metered' }, number: 'LEGACY' }),
    invoice('xss', { organizationName: '<script>alert(1)</script>', number: '<img src=x onerror=alert(1)>', pdfURL: 'https://evil.example/bill' }),
    ...Array.from({ length: 205 }, (_, i) => invoice(`archive-${i}`, { portalAccountID: `other-${i}`, month: '2025-01',
      issuedAt: Date.parse('2025-02-01T00:00:00+09:00'), number: `ARCHIVE-${i}` })),
  ];
  const store = new MojidasCorporateInvoiceStore({ now: () => clock, firestoreProvider: () => ({
    collection(name) {
      assert.equal(name, mojidasCollectionPath('corporateInvoices'), '請求履歴だけを参照');
      return { async get() {
        reads++;
        if (failed) throw Error('private backend error');
        return { docs: rows.map(row => ({ id: row.id, data: () => row })) };
      } };
    },
  }) });
  const before = structuredClone(rows);
  const listed = await store.listIssued();
  assert.equal(listed.length, rows.length - 1, '全法人・全期間を上限なしで取得');
  assert(listed.every((item, i) => !i || listed[i - 1].issuedAt >= item.issuedAt));
  assert.equal(listed.find(row => row.id === 'late').state, 'overdue');
  assert.equal(listed.find(row => row.id === 'paid').state, 'paid');
  assert.equal(listed.find(row => row.id === 'void').totalJPY, 0);
  assert.equal(listed.find(row => row.id === 'legacy').totalJPY, null, '不明な金額を0円にしない');
  assert.equal(listed.find(row => row.id === 'legacy').plan, 'metered');
  assert.equal(listed.find(row => row.id === 'uncollectible').pdfURL, null);
  assert.equal(listed.find(row => row.id === 'xss').pdfURL, null);
  assert.deepStrictEqual(rows, before, '閲覧で請求金額・状態・宛先等を変更しない');
  clock = base.issuedAt - 1;
  assert.equal((await store.listIssued()).find(row => row.id === 'late').state, 'open');
  clock = base.issuedAt;
  assert.equal((await store.listIssued()).find(row => row.id === 'late').state, 'overdue', '日本時間の期限翌日から超過表示');

  const app = express(); app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '../views'));
  app.use(express.static(path.join(__dirname, '../public')));
  app.locals.mojidasCorporateInvoiceStore = store; app.locals.adminAuthNow = () => clock;
  // 隔離HTTP試験専用。実セッション、認証サービス、Firestore、Stripeには接続しない。
  app.use((req, res, next) => {
    const role = req.get('X-Fixture-Role') || (preview ? 'admin' : 'anonymous');
    req.session = { cookie: {} };
    if (['admin', 'unverified', 'expired'].includes(role)) req.session.adminUser = {
      email: 'admin@example.invalid', secondFactorVerified: role !== 'unverified',
      lastAccessAt: role === 'expired' ? clock - IDLE_MS : clock,
    };
    if (role === 'corporate') req.session.corporateLogin = { id: 'portal' };
    if (role === 'partner') req.session.partnerLogin = { id: 'partner' };
    next();
  });
  app.use('/admin', adminActivity, require('../routes/admin'));
  const server = await listen(app);
  const admin = { headers: { 'X-Fixture-Role': 'admin' } };
  try {
    for (const role of ['anonymous', 'corporate', 'partner', 'unverified', 'expired']) {
      const count = reads, response = await request(server, '/admin/mojidas-invoices', { headers: { 'X-Fixture-Role': role } });
      assert.equal(response.status, 302); assert.equal(response.headers.location, '/admin');
      assert.equal(reads, count, '管理者以外には請求データを取得しない');
    }
    const count = reads, menu = await request(server, '/admin/mojidas', admin);
    assert.equal(menu.status, 200); assert(menu.text.includes('href="/admin/mojidas-invoices"'));
    assert(menu.text.includes('Mojidas請求履歴')); assert.equal(reads, count, 'メニュー閲覧では全件取得しない');
    const response = await request(server, '/admin/mojidas-invoices', admin);
    assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    for (const label of ['Mojidas請求履歴', '13,200円', '24,200円', '0円', '未払い', '支払済み', '支払期限超過', '取消', '回収不能', 'ARCHIVE-204'])
      assert(response.text.includes(label), label);
    assert(response.text.includes('2026/11/01 0:00')); assert(!response.text.includes('NOT-ISSUED'));
    assert(!response.text.includes('<script>alert(1)</script>')); assert(response.text.includes('&lt;script&gt;'));
    assert(!response.text.includes('href="https://evil.example')); assert(!response.text.includes('href="javascript:'));
    assert(response.text.includes('rel="noopener noreferrer"'));
    assert.deepStrictEqual(rows, before);
    rows = [];
    assert((await request(server, '/admin/mojidas-invoices', admin)).text.includes('発行済みの法人請求はありません'));
    failed = true;
    const error = await request(server, '/admin/mojidas-invoices', admin);
    assert.equal(error.status, 503); assert(error.text.includes('請求履歴を取得できませんでした'));
    assert(!error.text.includes('private backend error')); assert(!error.text.includes('発行済みの法人請求はありません'));
    failed = false; rows = examples; clock = Date.parse('2026-11-01T00:05:00+09:00');
    if (process.env.MOJIDAS_ADMIN_INVOICES_PREVIEW === '1') {
      preview = true;
      console.log(`隔離プレビュー: http://127.0.0.1:${server.address().port}/admin/mojidas`);
    }
  } finally {
    if (!preview) await new Promise(resolve => server.close(resolve));
  }
  console.log('Mojidas請求履歴: 全件・順序・期限・履歴保全・管理者限定・XSS・PDFリンク・空/取得失敗表示 成功');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
