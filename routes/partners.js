const express = require('express');
const crypto = require('crypto');
const defaultStore = require('../modules/partners/partner_store');
const { monthAt } = require('../modules/partners/usage_policy');
const { createMemoryRateLimiter } = require('../modules/auth/memory_rate_limiter');

function createPartnerRouter({ store = defaultStore, admin = false, now = Date.now } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!['app.mojidas.jp', 'localhost', '127.0.0.1', '::1'].includes(req.hostname)) return res.sendStatus(404);
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
    if (!req.session.partnerLogin || now() - req.session.partnerLogin.at >= 43200000) return null;
    return store.activePartner(req.session.partnerLogin.id);
  }
  async function render(req, res, mode, status = 200, error = '') {
    const user = admin ? null : await partner(req);
    if (!admin && mode === 'dashboard' && !user) return res.redirect('/partners');
    const month = typeof req.query.month === 'string' ? req.query.month : monthAt(now());
    const rows = mode === 'dashboard' ? await store.dashboard(user ? user.id : null, month) : [];
    return res.status(status).render('partners/index', { mode, admin, user, month, rows,
      partners: admin ? await store.listPartners() : [], csrf: req.session.partnerCSRF,
      base: admin ? '/admin/mojidas-partners' : '/partners', error });
  }
  router.get('/', wrap(async (req, res) => render(req, res, admin || await partner(req) ? 'dashboard' : 'login')));
  if (!admin) {
    router.get('/accept', wrap((req, res) => render(req, res, 'accept')));
    router.post('/login', limited, wrap(async (req, res) => {
      let id; try { id = await store.login(req.body.email, req.body.password); }
      catch (_) { return render(req, res, 'login', 401, 'ログインできませんでした。'); }
      await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
      req.session.partnerLogin = { id, at: now() }; req.session.cookie.maxAge = 43200000;
      return res.redirect(303, '/partners');
    }));
    router.post('/accept', limited, wrap(async (req, res) => {
      try {
        if (req.body.password !== req.body.confirmPassword) throw new Error();
        await store.accept(req.body.id, req.body.token, req.body.password);
        return res.redirect(303, '/partners');
      } catch (_) { return render(req, res, 'accept', 400, '招待の期限・パスワードの一致を確認し、招待メールのリンクから開き直してください。'); }
    }));
    router.post('/logout', (req, res) => { delete req.session.partnerLogin; res.redirect(303, '/partners'); });
    router.post('/domains', wrap(async (req, res) => {
      const user = await partner(req); if (!user) return res.sendStatus(401);
      try { await store.submit(user.id, req.body); }
      catch (error) { return render(req, res, 'dashboard', 400, error.message); }
      return res.redirect(303, '/partners');
    }));
  } else {
    router.post('/invite', limited, wrap(async (req, res) => {
      try { await store.invite(req.body.email, req.body.name); }
      catch (_) { return render(req, res, 'dashboard', 400, '招待できませんでした。登録状況・メール設定を確認してください。未完了の招待は再送できます。'); }
      return res.redirect(303, '/admin/mojidas-partners');
    }));
    router.post('/review', wrap(async (req, res) => {
      try { await store.review(req.body.domain, req.body.status, req.session.adminUser.email); }
      catch (error) { return render(req, res, 'dashboard', 400, error.message); }
      return res.redirect(303, '/admin/mojidas-partners');
    }));
  }
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(500).type('text').send('処理できませんでした。時間をおいて再度お試しください。');
  });
  return router;
}
module.exports = { createPartnerRouter };
