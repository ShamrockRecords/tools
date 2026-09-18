const session = require('express-session');
const { PersistentSessionStore } = require('./persistent_session_store');

function createWebSessions(options, { persistent = false, firestoreProvider } = {}) {
  const makeStore = scope => persistent
    ? new PersistentSessionStore({ scope, firestoreProvider }) : new session.MemoryStore();
  const standardSession = session({ ...options, store: options.store || makeStore('admin') });
  // 販売店専用のCookie・ストアを使用し、管理者セッションを共有しない。
  const partnerSession = session({
    ...options,
    name: 'mojidas.partner.sid',
    store: makeStore('partner'),
    cookie: { ...options.cookie, path: '/partners' },
  });
  return (req, res, next) => {
    const isPartner = req.path === '/partners' || req.path.startsWith('/partners/');
    return (isPartner ? partnerSession : standardSession)(req, res, next);
  };
}

module.exports = { createWebSessions };
