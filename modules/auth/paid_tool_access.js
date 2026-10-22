const crypto = require('crypto');
const { createMemoryRateLimiter } = require('./memory_rate_limiter');

function requireAdmin(req, res, next) {
  if (!req.session?.adminUser?.secondFactorVerified) {
    if (req.method === 'GET') return res.redirect('/admin');
    return res.status(401).send('管理者ログインが必要です。');
  }
  next();
}
function csrfToken(req) {
  if (!req.session.paidToolCSRF) req.session.paidToolCSRF = crypto.randomBytes(32).toString('hex');
  return req.session.paidToolCSRF;
}
function checkCSRF(req, res, next) {
  const expected = req.session.paidToolCSRF;
  const actual = req.get('X-CSRF-Token');
  if (!expected || typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual)
    || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) return res.sendStatus(403);
  next();
}
const limited = createMemoryRateLimiter({ windowMs: 60 * 60 * 1000, max: 120, keyPrefix: 'paid-tools' });
module.exports = { requireAdmin, csrfToken, checkCSRF, limited };
