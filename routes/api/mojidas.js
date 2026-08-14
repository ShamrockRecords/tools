const express = require('express');
const firebaseAdmin = require('firebase-admin');

const {
  FirebaseAuthError,
  FirebaseAuthRestClient,
} = require('../../modules/auth/firebase_auth_rest');
const mojidasUserStore = require('../../modules/auth/mojidas_user_store');
const { createMemoryRateLimiter } = require('../../modules/auth/memory_rate_limiter');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const DEFAULT_ALLOWED_HOSTS = ['app.mojidas.jp'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function createMojidasRouter({
  authClient,
  userStore = mojidasUserStore,
  allowedHosts,
  allowLocalhost = true,
} = {}) {
  const router = express.Router();
  const client = authClient || new FirebaseAuthRestClient({
    apiKey: process.env.FIREBASE_API_KEY,
    firebaseAdmin,
  });
  const registerRateLimit = createMemoryRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 5,
    keyPrefix: 'mojidas-register',
  });
  const loginRateLimit = createMemoryRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    keyPrefix: 'mojidas-login',
  });
  const refreshRateLimit = createMemoryRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 120,
    keyPrefix: 'mojidas-refresh',
  });
  const passwordResetRateLimit = createMemoryRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 5,
    keyPrefix: 'mojidas-password-reset',
  });

  router.use(createHostGuard({ allowedHosts, allowLocalhost }));

  router.post('/auth/register', registerRateLimit, async function (req, res) {
    const email = normalizeEmail(req.body.email);
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!isValidEmail(email)) {
      return sendError(res, 400, 'INVALID_EMAIL', 'メールアドレスの形式が正しくありません。');
    }
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return sendError(
        res,
        400,
        'INVALID_PASSWORD',
        `パスワードは${MIN_PASSWORD_LENGTH}文字以上${MAX_PASSWORD_LENGTH}文字以下で入力してください。`
      );
    }

    try {
      const user = await client.register(email, password);
      return res.status(201).json({
        user,
        verificationRequired: true,
      });
    } catch (error) {
      return sendAuthError(res, error);
    }
  });

  router.post('/auth/login', loginRateLimit, async function (req, res) {
    const email = normalizeEmail(req.body.email);
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!isValidEmail(email) || !password) {
      return sendError(
        res,
        400,
        'INVALID_CREDENTIALS',
        'メールアドレスとパスワードを入力してください。'
      );
    }

    try {
      const session = await client.login(email, password);
      await userStore.recordLogin({
        uid: session.user.id,
        email: session.user.email,
        emailVerified: session.user.emailVerified,
      });
      return res.json(session);
    } catch (error) {
      return sendAuthError(res, error);
    }
  });

  router.post('/auth/refresh', refreshRateLimit, async function (req, res) {
    const refreshToken = typeof req.body.refreshToken === 'string'
      ? req.body.refreshToken.trim()
      : '';

    if (!refreshToken) {
      return sendError(res, 400, 'MISSING_REFRESH_TOKEN', 'refreshTokenは必須です。');
    }

    try {
      const session = await client.refresh(refreshToken);
      return res.json(session);
    } catch (error) {
      return sendAuthError(res, error);
    }
  });

  router.post('/auth/password-reset', passwordResetRateLimit, async function (req, res) {
    const email = normalizeEmail(req.body.email);

    if (!isValidEmail(email)) {
      return sendError(res, 400, 'INVALID_EMAIL', 'メールアドレスの形式が正しくありません。');
    }

    try {
      await client.sendPasswordReset(email);
    } catch (error) {
      if (error.code !== 'EMAIL_NOT_FOUND') {
        return sendAuthError(res, error);
      }
    }

    // 登録の有無を第三者へ知らせないため、常に同じ応答にする。
    return res.status(202).json({
      message: 'アカウントが存在する場合は、パスワード再設定メールを送信しました。',
    });
  });

  router.get('/me', authenticate(client), async function (req, res) {
    return res.json({
      user: client.publicUser(req.mojidasUser),
    });
  });

  return router;
}

function createHostGuard({ allowedHosts, allowLocalhost = true } = {}) {
  const configuredHosts = allowedHosts || process.env.MOJIDAS_ALLOWED_HOSTS;
  const hostList = Array.isArray(configuredHosts)
    ? configuredHosts
    : String(configuredHosts || DEFAULT_ALLOWED_HOSTS.join(','))
      .split(',');
  const acceptedHosts = new Set(
    hostList
      .map((host) => normalizeHostname(host))
      .filter(Boolean)
  );

  return function (req, res, next) {
    const hostname = normalizeHostname(req.get('Host'));
    if (acceptedHosts.has(hostname) || (allowLocalhost && LOCAL_HOSTS.has(hostname))) {
      return next();
    }

    return sendError(res, 404, 'NOT_FOUND', '指定されたページは見つかりません。');
  };
}

function normalizeHostname(value) {
  const host = String(value || '').trim().toLowerCase();
  if (host.startsWith('[')) {
    const closingBracket = host.indexOf(']');
    return closingBracket > 0 ? host.slice(1, closingBracket) : '';
  }
  return host.split(':')[0].replace(/\.$/, '');
}

function authenticate(client) {
  return async function (req, res, next) {
    const authorization = req.get('Authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return sendError(res, 401, 'UNAUTHORIZED', '認証が必要です。');
    }

    try {
      req.mojidasUser = await client.verifyAccessToken(match[1]);
      return next();
    } catch (error) {
      return sendAuthError(res, error);
    }
  };
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isValidEmail(email) {
  return email.length <= 254 && EMAIL_REGEX.test(email);
}

function sendAuthError(res, error) {
  const rawCode = error && error.code ? error.code : 'AUTH_SERVICE_ERROR';
  const code = String(rawCode)
    .replace(/^auth\//, '')
    .replace(/-/g, '_')
    .toUpperCase();
  const mapping = {
    EMAIL_EXISTS: [409, 'このメールアドレスは既に登録されています。'],
    INVALID_EMAIL: [400, 'メールアドレスの形式が正しくありません。'],
    WEAK_PASSWORD: [400, 'パスワードが弱すぎます。'],
    EMAIL_NOT_FOUND: [401, 'メールアドレスまたはパスワードが正しくありません。'],
    INVALID_PASSWORD: [401, 'メールアドレスまたはパスワードが正しくありません。'],
    INVALID_LOGIN_CREDENTIALS: [401, 'メールアドレスまたはパスワードが正しくありません。'],
    EMAIL_NOT_VERIFIED: [403, '確認メール内のリンクを開いてからログインしてください。'],
    USER_DISABLED: [403, 'このアカウントは利用できません。'],
    TOO_MANY_ATTEMPTS_TRY_LATER: [429, '試行回数が多すぎます。しばらく待ってからお試しください。'],
    INVALID_REFRESH_TOKEN: [401, 'ログインの有効期限が切れました。もう一度ログインしてください。'],
    TOKEN_EXPIRED: [401, 'ログインの有効期限が切れました。もう一度ログインしてください。'],
    USER_NOT_FOUND: [401, 'ログインの有効期限が切れました。もう一度ログインしてください。'],
    ID_TOKEN_REVOKED: [401, 'ログインの有効期限が切れました。もう一度ログインしてください。'],
    AUTH_NOT_CONFIGURED: [503, '認証サーバーの設定が完了していません。'],
    OPERATION_NOT_ALLOWED: [503, 'メールアドレスによる登録が有効になっていません。'],
    VERIFICATION_EMAIL_FAILED: [502, 'アカウントは作成されました。ログインすると確認メールを再送します。'],
    FIREBASE_TIMEOUT: [504, '認証サーバーへの接続がタイムアウトしました。'],
  };
  const [status, message] = mapping[code] || [502, '認証サービスとの通信に失敗しました。'];
  return sendError(res, status, code, message);
}

function sendError(res, status, code, message) {
  return res.status(status).json({
    error: { code, message },
  });
}

const router = createMojidasRouter();

module.exports = router;
module.exports.createMojidasRouter = createMojidasRouter;
module.exports.createHostGuard = createHostGuard;
module.exports.isValidEmail = isValidEmail;
module.exports.normalizeEmail = normalizeEmail;
module.exports.normalizeHostname = normalizeHostname;
module.exports.sendAuthError = sendAuthError;
