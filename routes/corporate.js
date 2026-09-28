const express = require('express');
const crypto = require('crypto');
const { corporatePortalStore } = require('../modules/partners/corporate_portal_store');
const { LOGIN_DURATION_MS } = require('../modules/auth/persistent_session_store');
const { createMemoryRateLimiter } = require('../modules/auth/memory_rate_limiter');

function createCorporateRouter({ store = corporatePortalStore, now = Date.now } = {}) {
  const router = express.Router();
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const regenerate = req => new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  const redirect = (req, res) => new Promise((resolve, reject) => req.session.save(error => {
    if (error) return reject(error);
    res.redirect(303, '/corporate'); resolve();
  }));
  const limited = createMemoryRateLimiter({ windowMs: 15 * 60000, max: 15, keyPrefix: 'corporate-auth',
    keyGenerator: req => req.ip || req.socket.remoteAddress });
  router.use((req, res, next) => {
    const host = String(req.get('host') || '').toLowerCase();
    if (!/^(app\.mojidas\.jp|localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return res.sendStatus(404);
    res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'");
    if (!req.session.corporateCSRF) req.session.corporateCSRF = crypto.randomBytes(32).toString('hex');
    if (req.method === 'POST' && (typeof req.body.csrfToken !== 'string' || !/^[a-f0-9]{64}$/.test(req.body.csrfToken)
      || !crypto.timingSafeEqual(Buffer.from(req.body.csrfToken), Buffer.from(req.session.corporateCSRF)))) return res.sendStatus(403);
    next();
  });
  async function current(req) {
    const login = req.session.corporateLogin;
    if (!login || now() - login.at >= (login.mustChangePassword ? 15 * 60000 : LOGIN_DURATION_MS)) return null;
    return store.account(login, true);
  }
  async function render(req, res, error = '', status = 200, passwordPage = false) {
    const user = await current(req);
    const mode = !user ? 'login' : user.mustChangePassword
      ? (req.session.corporateCodeVerified ? 'initial-password' : 'verify')
      : passwordPage ? 'password' : 'dashboard';
    const rows = mode === 'dashboard' ? await store.dashboard(user) : [];
    const domain = req.query.domain || rows[0]?.domain;
    let overview = null;
    if (mode === 'dashboard' && domain && store.management) {
      try { overview = await store.management.overview(user, { ...req.query, domain }); }
      catch (_) { error = error || '一覧を取得できませんでした。対象ドメイン・対象月を確認し、再度お試しください。'; status = 400; }
    }
    return res.status(status).render('corporate/index', { user, mode, error, overview,
      csrf: req.session.corporateCSRF, rows });
  }
  router.get('/', wrap((req, res) => render(req, res)));
  for (const [path, method] of [['member-policy', 'policy'], ['members', 'setMembers']]) {
    router.post(`/${path}`, wrap(async (req, res) => {
      const user = await current(req);
      if (!user || user.mustChangePassword) return res.sendStatus(403);
      try { await store.management[method](user, req.body); }
      catch (_) {
        if (path === 'member-policy' && req.get('Accept') === 'application/json') return res.status(400).json({ error: '保存できませんでした。再度お試しください。' });
        return render(req, res, '保存できませんでした。対象・選択内容を確認し、再度お試しください。', 400);
      }
      if (path === 'member-policy' && req.get('Accept') === 'application/json') return res.json({ autoEnable: req.body.mode === 'auto' });
      const query = new URLSearchParams({ domain: req.body.domain });
      if (typeof req.body.month === 'string') query.set('month', req.body.month);
      if (typeof req.body.q === 'string') query.set('q', req.body.q);
      if (typeof req.body.page === 'string') query.set('page', req.body.page);
      return res.redirect(303, `/corporate?${query}`);
    }));
  }
  router.post('/login', limited, wrap(async (req, res) => {
    let login;
    try { login = await store.login(req.body.email, req.body.password); }
    catch (_) { return render(req, res, 'ログインできませんでした。メールアドレス・パスワードを確認し、試行を繰り返した場合は15分後にお試しください。', 401); }
    await regenerate(req);
    req.session.corporateCSRF = crypto.randomBytes(32).toString('hex');
    req.session.corporateLogin = { ...login, at: now() };
    req.session.cookie.maxAge = login.mustChangePassword ? 15 * 60000 : LOGIN_DURATION_MS;
    if (login.mustChangePassword) {
      try { req.session.corporateChallengeID = await store.challenge(login); }
      catch (error) { return render(req, res, error.message, 400); }
    }
    return redirect(req, res);
  }));
  router.post('/verify', limited, wrap(async (req, res) => {
    const user = await current(req);
    if (!user?.mustChangePassword) return res.sendStatus(403);
    try { await store.verifyCode(user, req.session.corporateChallengeID, req.body.code); }
    catch (error) { return render(req, res, error.message, 400); }
    req.session.corporateCodeVerified = true;
    return redirect(req, res);
  }));
  router.post('/resend', limited, wrap(async (req, res) => {
    const user = await current(req);
    if (!user?.mustChangePassword) return res.sendStatus(403);
    try {
      req.session.corporateChallengeID = await store.challenge(user);
      req.session.corporateCodeVerified = false;
    } catch (error) { return render(req, res, error.message, 400); }
    return redirect(req, res);
  }));
  router.get('/password', wrap((req, res) => render(req, res, '', 200, true)));
  router.post('/password', limited, wrap(async (req, res) => {
    const user = await current(req);
    if (!user || (user.mustChangePassword && !req.session.corporateCodeVerified)) return res.sendStatus(403);
    let updated;
    try {
      if (req.body.password !== req.body.confirmPassword) throw new Error('新しいパスワードと確認用の入力が一致しません。');
      updated = await store.changePassword(user, { password: req.body.password, currentPassword: req.body.currentPassword,
        challengeID: req.session.corporateChallengeID });
    } catch (error) { return render(req, res, error.message, 400, true); }
    await regenerate(req);
    req.session.corporateLogin = { ...updated, at: now() };
    req.session.cookie.maxAge = LOGIN_DURATION_MS;
    return redirect(req, res);
  }));
  router.post('/logout', wrap(async (req, res) => { await regenerate(req); return redirect(req, res); }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(500).type('text').send('処理できませんでした。時間をおいて再度お試しください。');
  });
  return router;
}
module.exports = { createCorporateRouter };
