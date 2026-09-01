const MAX_TRACKED_KEYS = 10000;

function createMemoryRateLimiter({ windowMs, max, keyPrefix, keyGenerator, onLimit }) {
  const attempts = new Map();

  return function (req, res, next) {
    const now = Date.now();
    const forwarded = (req.get('X-Forwarded-For') || '').split(',')[0].trim();
    const address = forwarded || req.ip || req.socket.remoteAddress || 'unknown';
    const generatedKey = typeof keyGenerator === 'function' ? keyGenerator(req) : '';
    const identity = typeof generatedKey === 'string' && generatedKey.trim()
      ? generatedKey.trim()
      : address;
    const key = `${keyPrefix}:${identity}`;
    const current = attempts.get(key);

    if (!current || current.resetAt <= now) {
      if (attempts.size >= MAX_TRACKED_KEYS) {
        attempts.delete(attempts.keys().next().value);
      }
      attempts.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    current.count += 1;
    if (current.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfterSeconds));
      if (typeof onLimit === 'function') {
        return onLimit(req, res, retryAfterSeconds);
      }
      return res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: '試行回数が多すぎます。しばらく待ってからお試しください。',
        },
      });
    }

    return next();
  };
}

module.exports = {
  createMemoryRateLimiter,
};
