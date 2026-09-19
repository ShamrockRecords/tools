const express = require('express');
const { validateInquiry, createInquiryService } = require('../../modules/business_inquiry');
const { createMemoryRateLimiter } = require('../../modules/auth/memory_rate_limiter');

function createBusinessInquiryRouter({ general = false, service = createInquiryService({ general }), allowLocalhost = process.env.NODE_ENV !== 'production' } = {}) {
  const router = express.Router();
  const origins = new Set(['https://mojidas.jp', 'https://www.mojidas.jp', 'https://app.mojidas.jp']);
  router.use((req, res, next) => {
    const origin = req.get('Origin');
    let local = false;
    try { const url = new URL(origin); local = allowLocalhost && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname); } catch (_) { /* 不正なOriginは許可しない */ }
    res.set('Cache-Control', 'no-store');
    res.vary('Origin');
    if (!origins.has(origin) && !local) return res.status(403).json({ error: { message: 'MojidasのWebページから送信してください。' } });
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  router.post('/', createMemoryRateLimiter({ windowMs: 60 * 60 * 1000, max: 5, keyPrefix: 'business-inquiry', keyGenerator: req => req.ip || req.socket.remoteAddress }), async (req, res) => {
    try {
      if (!req.is('application/json')) return res.status(415).json({ error: { message: '送信形式が正しくありません。' } });
      const data = validateInquiry(req.body, { general });
      return res.json(await service(data));
    } catch (error) {
      return res.status(error.status || 503).json({ error: { message: error.status ? error.message : '現在送信できません。時間をおいて再度お試しください。' } });
    }
  });
  return router;
}

module.exports = { createBusinessInquiryRouter };
