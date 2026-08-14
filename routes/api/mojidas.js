const express = require('express');
const firebaseAdmin = require('firebase-admin');

const {
  FirebaseAuthError,
  FirebaseAuthRestClient,
} = require('../../modules/auth/firebase_auth_rest');
const mojidasUserStore = require('../../modules/auth/mojidas_user_store');
const { createMemoryRateLimiter } = require('../../modules/auth/memory_rate_limiter');
const { ACPApiKeyIssuer } = require('../../modules/acp/api_key_issuer');
const mojidasCreditStore = require('../../modules/credit/mojidas_credit_store');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const DEFAULT_ALLOWED_HOSTS = ['app.mojidas.jp'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function createMojidasRouter({
  authClient,
  userStore = mojidasUserStore,
  apiKeyIssuer,
  creditStore = mojidasCreditStore,
  allowedHosts,
  allowLocalhost = true,
} = {}) {
  const router = express.Router();
  const client = authClient || new FirebaseAuthRestClient({
    apiKey: process.env.FIREBASE_API_KEY,
    firebaseAdmin,
  });
  const issuer = apiKeyIssuer || new ACPApiKeyIssuer();
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
  const verifyEmailRateLimit = createMemoryRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyPrefix: 'mojidas-verify-email',
  });
  const resendVerificationRateLimit = createMemoryRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 5,
    keyPrefix: 'mojidas-resend-verification',
  });
  const trialAppKeyRateLimit = createMemoryRateLimiter({
    windowMs: 60 * 1000,
    max: 8,
    keyPrefix: 'mojidas-trial-appkey',
  });
  const authenticatedAppKeyRateLimit = createMemoryRateLimiter({
    windowMs: 60 * 1000,
    max: 20,
    keyPrefix: 'mojidas-authenticated-appkey',
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

  router.post('/auth/verify-email', verifyEmailRateLimit, async function (req, res) {
    const email = normalizeEmail(req.body.email);
    const code = normalizeVerificationCode(req.body.code);
    if (!isValidEmail(email) || !code) {
      return sendError(
        res,
        400,
        'INVALID_VERIFICATION_CODE',
        'メールアドレスと6桁の認証コードを確認してください。'
      );
    }

    try {
      await client.confirmEmailCode(email, code);
      return res.json({ verified: true });
    } catch (error) {
      return sendAuthError(res, error);
    }
  });

  router.post('/auth/verification/resend', resendVerificationRateLimit, async function (req, res) {
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
      return res.json(await client.resendVerificationCode(email, password));
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

  router.get('/credits/balance', authenticate(client), async function (req, res) {
    try {
      return res.json(await creditStore.getBalance({
        userID: req.mojidasUser.uid,
        accountCreatedAt: accountCreationTime(req.mojidasUser),
      }));
    } catch (error) {
      return sendCreditError(res, error);
    }
  });

  router.post('/usage/reservations', authenticate(client), async function (req, res) {
    const operation = ['realtime', 'mediaFile'].includes(req.body.mode) ? req.body.mode : '';
    const clientSessionID = normalizeUUID(req.body.clientSessionID);
    const recognitionRunID = normalizeUUID(req.body.recognitionRunID);
    const requestedMilliseconds = normalizeMilliseconds(req.body.requestedMilliseconds, false);
    const trackCount = normalizeTrackCount(req.body.trackCount);
    if (!operation || !clientSessionID || !recognitionRunID || !requestedMilliseconds || !trackCount) {
      return sendError(
        res,
        400,
        'INVALID_RESERVATION_REQUEST',
        '音声認識時間の予約内容が正しくありません。'
      );
    }

    try {
      const reservation = await creditStore.createReservation({
        userID: req.mojidasUser.uid,
        accountCreatedAt: accountCreationTime(req.mojidasUser),
        operation,
        clientSessionID,
        recognitionRunID,
        requestedMilliseconds,
        trackCount,
      });
      return res.status(201).json(reservation);
    } catch (error) {
      return sendCreditError(res, error);
    }
  });

  router.post('/usage/:reservationID/heartbeat', authenticate(client), async function (req, res) {
    const reservationID = normalizeIdentifier(req.params.reservationID);
    const sequence = normalizeSequence(req.body.sequence);
    const consumedMilliseconds = normalizeMilliseconds(req.body.consumedMilliseconds, true);
    if (!reservationID || !sequence || consumedMilliseconds === null) {
      return sendError(res, 400, 'INVALID_HEARTBEAT', '利用時間の更新内容が正しくありません。');
    }

    try {
      await creditStore.heartbeat({
        reservationID,
        userID: req.mojidasUser.uid,
        accountCreatedAt: accountCreationTime(req.mojidasUser),
        sequence,
        consumedMilliseconds,
      });
      return res.json({});
    } catch (error) {
      return sendCreditError(res, error);
    }
  });

  router.post('/usage/:reservationID/complete', authenticate(client), async function (req, res) {
    return finalizeCreditReservation(req, res, creditStore, false);
  });

  router.post('/usage/:reservationID/cancel', authenticate(client), async function (req, res) {
    return finalizeCreditReservation(req, res, creditStore, true);
  });

  router.post('/acp/trial-appkey', trialAppKeyRateLimit, async function (req, res) {
    const recognitionRunID = normalizeUUID(req.body.recognitionRunID);
    if (!recognitionRunID) {
      return sendError(res, 400, 'INVALID_RECOGNITION_RUN_ID', 'recognitionRunIDは必須です。');
    }

    try {
      return res.json(await issuer.issue());
    } catch (error) {
      return sendAppKeyError(res, error);
    }
  });

  router.post(
    '/acp/instant-appkey',
    authenticatedAppKeyRateLimit,
    authenticate(client),
    async function (req, res) {
      const reservationID = normalizeIdentifier(req.body.reservationID);
      if (!reservationID) {
        return sendError(res, 400, 'INVALID_RESERVATION_ID', 'reservationIDは必須です。');
      }

      try {
        await creditStore.assertActiveReservation({
          reservationID,
          userID: req.mojidasUser.uid,
        });
        return res.json(await issuer.issue());
      } catch (error) {
        return sendAppKeyError(res, error);
      }
    }
  );

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

function normalizeVerificationCode(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(normalized) ? normalized : '';
}

function normalizeIdentifier(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(normalized) ? normalized : '';
}

function normalizeUUID(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : '';
}

function normalizeMilliseconds(value, allowZero) {
  if (!Number.isSafeInteger(value)) return null;
  if (allowZero ? value < 0 : value <= 0) return null;
  if (value > 7 * 24 * 60 * 60 * 1000) return null;
  return value;
}

function normalizeSequence(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeTrackCount(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 2 ? value : null;
}

function accountCreationTime(user) {
  return user && user.metadata && user.metadata.creationTime
    ? user.metadata.creationTime
    : new Date(0);
}

async function finalizeCreditReservation(req, res, creditStore, cancelled) {
  const reservationID = normalizeIdentifier(req.params.reservationID);
  const consumedMilliseconds = normalizeMilliseconds(req.body.consumedMilliseconds, true);
  if (!reservationID || consumedMilliseconds === null) {
    return sendError(res, 400, 'INVALID_COMPLETION', '利用時間の確定内容が正しくありません。');
  }
  try {
    await creditStore.completeReservation({
      reservationID,
      userID: req.mojidasUser.uid,
      consumedMilliseconds,
      cancelled,
    });
    return res.json({});
  } catch (error) {
    return sendCreditError(res, error);
  }
}

function sendCreditError(res, error) {
  const code = error && error.code ? error.code : 'CREDIT_SERVICE_ERROR';
  const mapping = {
    INSUFFICIENT_CREDIT: [409, '音声認識時間が不足しています。'],
    RESERVATION_NOT_FOUND: [404, '利用時間の予約が見つかりません。'],
    RESERVATION_EXPIRED: [409, '利用時間の予約期限が切れています。'],
    INVALID_SEQUENCE: [409, '利用時間の更新順序が正しくありません。'],
    INVALID_ACCOUNT_DATE: [500, 'アカウントの登録日時を確認できませんでした。'],
  };
  const [status, message] = mapping[code] || [500, '音声認識時間を取得できませんでした。'];
  const body = { error: { code, message } };
  if (error && error.details) Object.assign(body.error, error.details);
  return res.status(status).json(body);
}

function sendAppKeyError(res, error) {
  const code = error && error.code ? error.code : 'APPKEY_UNAVAILABLE';
  const mapping = {
    RESERVATION_NOT_FOUND: [404, '利用時間の予約が見つかりません。'],
    RESERVATION_EXPIRED: [409, '利用時間の予約期限が切れています。'],
    ACP_NOT_CONFIGURED: [503, '音声認識サーバーの設定が完了していません。'],
    ACP_TIMEOUT: [504, '音声認識サーバーへの接続がタイムアウトしました。'],
    ACP_REQUEST_FAILED: [502, '音声認識サーバーへ接続できませんでした。'],
    ACP_INVALID_RESPONSE: [502, '音声認識サーバーから有効なキーを取得できませんでした。'],
  };
  const [status, message] = mapping[code] || [503, '音声認識を開始するキーを取得できませんでした。'];
  return sendError(res, status, code, message);
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
    EMAIL_NOT_VERIFIED: [403, '6桁の認証コードを送信しました。コードを入力してください。'],
    INVALID_VERIFICATION_CODE: [400, '認証コードが正しくありません。'],
    EXPIRED_VERIFICATION_CODE: [410, '認証コードの有効期限が切れています。新しいコードを送信してください。'],
    VERIFICATION_ATTEMPTS_EXCEEDED: [429, '認証コードの入力回数が上限に達しました。新しいコードを送信してください。'],
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
module.exports.normalizeVerificationCode = normalizeVerificationCode;
module.exports.sendAuthError = sendAuthError;
module.exports.normalizeIdentifier = normalizeIdentifier;
module.exports.normalizeUUID = normalizeUUID;
module.exports.sendAppKeyError = sendAppKeyError;
module.exports.accountCreationTime = accountCreationTime;
module.exports.normalizeMilliseconds = normalizeMilliseconds;
module.exports.normalizeSequence = normalizeSequence;
module.exports.normalizeTrackCount = normalizeTrackCount;
module.exports.sendCreditError = sendCreditError;
