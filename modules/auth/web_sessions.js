const session = require('express-session');

function createWebSessions(options) {
  const standardSession = session(options);
  // 販売店専用のCookie・ストアを使用し、管理者セッションを共有しない。
  const partnerSession = session({
    ...options,
    name: 'mojidas.partner.sid',
    store: new session.MemoryStore(),
    cookie: { ...options.cookie, path: '/partners' },
  });
  return (req, res, next) => {
    const isPartner = req.path === '/partners' || req.path.startsWith('/partners/');
    return (isPartner ? partnerSession : standardSession)(req, res, next);
  };
}

module.exports = { createWebSessions };
