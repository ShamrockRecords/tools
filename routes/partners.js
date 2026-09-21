const express = require('express');
const crypto = require('crypto');
const defaultStore = require('../modules/partners/partner_store');
const { monthAt } = require('../modules/partners/usage_policy');
const { createMemoryRateLimiter } = require('../modules/auth/memory_rate_limiter');
const { LOGIN_DURATION_MS } = require('../modules/auth/persistent_session_store');

function createPartnerRouter({ store = defaultStore, admin = false, now = Date.now } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    // 管理画面は既存/adminと同じホスト・管理者セッションで利用する。
    // 販売店向けページだけをapp.mojidas.jpに限定する。
    if (!admin && !['app.mojidas.jp', 'localhost', '127.0.0.1', '::1'].includes(req.hostname)) return res.sendStatus(404);
    res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'");
    if (!req.session.partnerCSRF) req.session.partnerCSRF = crypto.randomBytes(32).toString('hex');
    if (admin && !req.session.adminUser) return res.redirect('/admin');
    if (req.method === 'POST' && (!/^[a-f0-9]{64}$/.test(req.body.csrfToken || '')
        || !crypto.timingSafeEqual(Buffer.from(req.body.csrfToken), Buffer.from(req.session.partnerCSRF)))) return res.sendStatus(403);
    return next();
  });
  const limited = createMemoryRateLimiter({ windowMs: 900000, max: 10, keyPrefix: admin ? 'partner-admin' : 'partner-login' });
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  async function partner(req) {
    if (!req.session.partnerLogin || now() - req.session.partnerLogin.at >= LOGIN_DURATION_MS) return null;
    return store.activePartner(req.session.partnerLogin.id);
  }
  async function render(req, res, mode, status = 200, error = '') {
    if (!req.session.partnerCSRF) req.session.partnerCSRF = crypto.randomBytes(32).toString('hex');
    const user = admin ? null : await partner(req);
    if (!admin && mode === 'dashboard' && !user) return res.redirect('/partners');
    const month = typeof req.query.month === 'string' ? req.query.month : monthAt(now());
    const year = req.query.year === undefined ? Number(monthAt(now()).slice(0, 4)) : Number(req.query.year);
    if (!Number.isInteger(year) || year < 2000 || year > 9999)
      return res.status(400).type('text').send('対象年を確認してください。');
    const rows = mode === 'dashboard' ? await store.dashboard(user ? user.id : null, month) : [];
    const annualRows = mode === 'dashboard' ? await store.yearlyUsage(user ? user.id : null, year) : [];
    return res.status(status).render('partners/index', { mode, admin, user, month, rows, year, annualRows,
      partners: admin ? await store.listPartners() : [], csrf: req.session.partnerCSRF,
      base: admin ? '/admin/mojidas-partners' : '/partners', error });
  }
  router.get('/', wrap(async (req, res) => render(req, res, admin || await partner(req) ? 'dashboard' : 'login')));
  function adminUpdated(req, res) {
    if (req.get('X-Requested-With') === 'MojidasDOM') return render(req, res, 'dashboard');
    return res.redirect(303, '/admin/mojidas-partners');
  }
  if (!admin) {
    router.get('/accept', wrap((req, res) => render(req, res, 'accept')));
    router.post('/login', limited, wrap(async (req, res) => {
      let id; try { id = await store.login(req.body.email, req.body.password); }
      catch (_) { return render(req, res, 'login', 401, 'ログインできませんでした。'); }
      await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
      req.session.partnerLogin = { id, at: now() }; req.session.cookie.maxAge = LOGIN_DURATION_MS;
      if (req.get('X-Requested-With') === 'MojidasDOM') return render(req, res, 'dashboard');
      return res.redirect(303, '/partners');
    }));
    router.post('/accept', limited, wrap(async (req, res) => {
      try {
        if (req.body.password !== req.body.confirmPassword) throw new Error();
        await store.accept(req.body.id, req.body.token, req.body.password);
        if (req.get('X-Requested-With') === 'MojidasDOM') return render(req, res, 'login');
        return res.redirect(303, '/partners');
      } catch (_) { return render(req, res, 'accept', 400, '招待の期限・パスワードの一致を確認し、招待メールのリンクから開き直してください。'); }
    }));
    router.post('/logout', wrap(async (req, res) => {
      await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
      if (req.get('X-Requested-With') === 'MojidasDOM') return render(req, res, 'login');
      return res.redirect(303, '/partners');
    }));
  } else {
    router.post('/domains/portal-invite', limited, wrap(async (req, res) => {
      try {
        if (!store.portal) throw new Error('法人ポータルが設定されていません。');
        const { normalizeDomain } = require('../modules/partners/domain_policy');
        const domain = normalizeDomain(req.body.domain);
        if (!domain) throw new Error('ドメインを確認してください。');
        await store.portal.deliverForDomain(domain);
      } catch (error) { return render(req, res, 'dashboard', 400, error.message); }
      return adminUpdated(req, res);
    }));
    router.post('/domains/delete', wrap(async (req, res) => {
      try { await store.deleteDomain(req.body.domain); }
      catch (error) { return render(req, res, 'dashboard', 400, error.message); }
      return adminUpdated(req, res);
    }));
    router.post('/domains', wrap(async (req, res) => {
      try { await store.addDomain(req.body.partnerID, req.body, req.session.adminUser.email); }
      catch (error) { return render(req, res, 'dashboard', 400, error.message); }
      return adminUpdated(req, res);
    }));
    router.post('/edit', wrap(async (req, res) => {
      try { await store.updateName(req.body.id, req.body.name); }
      catch (error) { return render(req, res, 'dashboard', 400, error.message); }
      return adminUpdated(req, res);
    }));
    router.post('/status', wrap(async (req, res) => {
      try { await store.setPartnerStatus(req.body.id, req.body.status, req.session.adminUser.email); }
      catch (error) { return render(req, res, 'dashboard', 400, error.message); }
      return adminUpdated(req, res);
    }));
    router.post('/invite', limited, wrap(async (req, res) => {
      try { await store.invite(req.body.email, req.body.name); }
      catch (_) { return render(req, res, 'dashboard', 400, '招待できませんでした。登録状況・メール設定を確認してください。未完了の招待は再送できます。'); }
      return adminUpdated(req, res);
    }));
    router.post('/domains/status', wrap(async (req, res) => {
      try { await store.setDomainStatus(req.body.domain, req.body.status, req.session.adminUser.email); }
      catch (error) { return render(req, res, 'dashboard', 400, error.message); }
      return adminUpdated(req, res);
    }));
  }
  router.post('/domains/edit', wrap(async (req, res) => {
    const user = admin ? null : await partner(req);
    if (!admin && !user) return res.sendStatus(401);
    try { await store.updateDomain(admin ? null : user.id, req.body); }
    catch (error) { return render(req, res, 'dashboard', 400, error.message); }
    if (req.get('X-Requested-With') === 'MojidasDOM') return render(req, res, 'dashboard');
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.body.month || '') ? req.body.month : monthAt(now());
    return res.redirect(303, `${admin ? '/admin/mojidas-partners' : '/partners'}?month=${month}`);
  }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(500).type('text').send('処理できませんでした。時間をおいて再度お試しください。');
  });
  return router;
}
module.exports = { createPartnerRouter };
