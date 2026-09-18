const crypto = require('crypto');
const express = require('express');
const {
  ServicePropertiesMonitor,
  publicError,
} = require('../../modules/monitoring/udtalk_service_properties');

function createUdtalkMonitorRouter({
  monitor = new ServicePropertiesMonitor(),
  token = process.env.UDTALK_MONITOR_API_TOKEN,
} = {}) {
  const router = express.Router();
  const configuredToken = typeof token === 'string' ? token.trim() : '';
  router.post('/service-properties/check', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!configuredToken) {
      return res.status(503).json({ error: {
        code: 'MONITOR_API_NOT_CONFIGURED', message: '監視APIの認証トークンが未設定です。',
      } });
    }
    const authorization = req.get('Authorization') || '';
    const match = /^Bearer (\S+)$/i.exec(authorization);
    const digest = value => crypto.createHash('sha256').update(value).digest();
    if (!match || !crypto.timingSafeEqual(digest(match[1]), digest(configuredToken))) {
      return res.status(401).json({ error: {
        code: 'UNAUTHORIZED', message: '監視APIの認証に失敗しました。',
      } });
    }
    try {
      const result = await monitor.check();
      return res.status(result.ok ? 200 : 502).json(result);
    } catch (error) {
      const safeError = publicError(error);
      const status = safeError.code === 'MONITOR_NOT_CONFIGURED' ? 503
        : safeError.code === 'ALERT_EMAIL_FAILED' ? 502 : 500;
      return res.status(status).json({ error: safeError, result: error.result });
    }
  });
  return router;
}

module.exports = { createUdtalkMonitorRouter };
