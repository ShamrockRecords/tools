const express = require('express');
const firebaseAdmin = require('firebase-admin');

const {
  FirebaseAuthError,
  FirebaseAuthRestClient,
} = require('../../modules/auth/firebase_auth_rest');
const mojidasUserStore = require('../../modules/auth/mojidas_user_store');
const { isInvitedUnlimited } = require('../../modules/auth/mojidas_access_policy');
const { createMemoryRateLimiter } = require('../../modules/auth/memory_rate_limiter');
const {
  ACPApiKeyIssuer,
  MEDIA_ASYNC_EXPIRY_MILLISECONDS,
} = require('../../modules/acp/api_key_issuer');
const mojidasCreditStore = require('../../modules/credit/mojidas_credit_store');
const mojidasDictionaryStore = require('../../modules/dictionary/mojidas_dictionary_store');
const {
  mojidasStripeBillingService,
} = require('../../modules/billing/mojidas_stripe_billing');
const {
  publicServiceConfiguration,
} = require('../../modules/mojidas_service_configuration');
const mojidasVersionStore = require('../../modules/mojidas_version_store');

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
  dictionaryStore = mojidasDictionaryStore,
  billingService = mojidasStripeBillingService,
  serviceConfigurationProvider = publicServiceConfiguration,
  versionStore = mojidasVersionStore,
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
  const checkoutRateLimit = createMemoryRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 20,
    keyPrefix: 'mojidas-checkout',
  });

  router.use(createHostGuard({ allowedHosts, allowLocalhost }));

  router.get('/configuration', function (req, res) {
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    return res.json(serviceConfigurationProvider());
  });

  router.get('/version', async function (req, res) {
    try {
      res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
      return res.json(await versionStore.getVersions());
    } catch (error) {
      console.error('[Mojidas] version fetch failed:', error);
      return sendError(
        res,
        503,
        'VERSION_UNAVAILABLE',
        'バージョン情報を取得できませんでした。'
      );
    }
  });

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
      const session = await client.confirmEmailCode(email, code);
      await userStore.recordLogin({
        uid: session.user.id,
        email: session.user.email,
        emailVerified: session.user.emailVerified,
      });
      return res.json({ verified: true, ...session });
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
      const balance = await creditStore.getBalance({
        userID: req.mojidasUser.uid,
        accountCreatedAt: accountCreationTime(req.mojidasUser),
        isUnlimited: isInvitedUnlimited(req.mojidasUser),
      });
      return res.json({
        ...balance,
        configuration: serviceConfigurationProvider(),
      });
    } catch (error) {
      return sendCreditError(res, error);
    }
  });

  router.get('/dictionary/changes', authenticate(client), async function (req, res) {
    const afterRevision = Number(req.query.afterRevision || 0);
    try {
      return res.json(await dictionaryStore.getChanges({
        userID: req.mojidasUser.uid,
        afterRevision,
      }));
    } catch (error) {
      return sendDictionaryError(res, error);
    }
  });

  router.post('/dictionary/sync', authenticate(client), async function (req, res) {
    try {
      return res.json(await dictionaryStore.synchronize({
        userID: req.mojidasUser.uid,
        deviceID: req.body.deviceID,
        mutations: req.body.mutations,
      }));
    } catch (error) {
      return sendDictionaryError(res, error);
    }
  });

  router.post(
    '/billing/checkout-session',
    checkoutRateLimit,
    authenticate(client),
    async function (req, res) {
      try {
        const checkout = await billingService.createCheckoutSession({
          userID: req.mojidasUser.uid,
          email: req.mojidasUser.email,
          productID: req.body.productID,
        });
        return res.status(201).json(checkout);
      } catch (error) {
        return sendBillingError(res, error);
      }
    }
  );

  router.get('/billing/success', function (req, res) {
    return res.type('html').send(checkoutResultPage({
      status: 'success',
      title: '購入を受け付けました',
      message: '決済の確認後、Mojidasの認識可能時間へ反映します。アプリに戻って残時間を更新してください。',
    }));
  });

  router.get('/billing/cancel', function (req, res) {
    return res.type('html').send(checkoutResultPage({
      status: 'cancel',
      title: '購入をキャンセルしました',
      message: '音声認識時間は購入されていません。このページを閉じてMojidasへ戻れます。',
    }));
  });

  router.post('/usage/reservations', authenticate(client), async function (req, res) {
    const operation = ['realtime', 'mediaFile'].includes(req.body.mode) ? req.body.mode : '';
    const clientSessionID = normalizeUUID(req.body.clientSessionID);
    const recognitionRunID = normalizeUUID(req.body.recognitionRunID);
    const requestedMilliseconds = normalizeMilliseconds(
      req.body.requestedMilliseconds,
      operation === 'realtime'
    );
    const trackCount = normalizeTrackCount(req.body.trackCount);
    if (
      !operation
      || !clientSessionID
      || !recognitionRunID
      || requestedMilliseconds === null
      || !trackCount
    ) {
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
        isUnlimited: isInvitedUnlimited(req.mojidasUser),
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
        const reservation = await creditStore.assertActiveReservation({
          reservationID,
          userID: req.mojidasUser.uid,
        });
        const issueOptions = reservation?.mode === 'mediaFile'
          ? { expiryMilliseconds: MEDIA_ASYNC_EXPIRY_MILLISECONDS }
          : undefined;
        return res.json(await issuer.issue(issueOptions));
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

function sendDictionaryError(res, error) {
  const code = error && error.code ? error.code : 'DICTIONARY_SERVICE_ERROR';
  const mapping = {
    INVALID_DEVICE_ID: [400, '端末情報を確認してください。'],
    INVALID_WORD_ID: [400, '単語情報を確認してください。'],
    INVALID_WORD: [400, '単語の書き表記と読み表記を確認してください。'],
    INVALID_MUTATIONS: [400, '単語辞書の更新内容を確認してください。'],
    INVALID_REVISION: [400, '単語辞書の同期位置を確認してください。'],
    INVALID_SEQUENCE: [409, '単語辞書の更新順序が競合しました。もう一度同期してください。'],
    WORD_LIMIT_REACHED: [409, 'Mojidasに登録できる単語は最大1,000語です。'],
  };
  const [status, message] = mapping[code] || [500, '単語辞書を同期できませんでした。'];
  const body = { error: { code, message } };
  if (error && error.details) Object.assign(body.error, error.details);
  return res.status(status).json(body);
}

function sendBillingError(res, error) {
  const code = error && error.code ? error.code : 'BILLING_SERVICE_ERROR';
  const mapping = {
    INVALID_PRODUCT: [400, '購入する商品を確認してください。'],
    INVALID_CUSTOMER: [400, 'アカウント情報を確認してください。'],
    STRIPE_NOT_CONFIGURED: [503, '購入機能の設定が完了していません。'],
    CHECKOUT_CREATE_FAILED: [502, '購入ページを作成できませんでした。'],
  };
  const [status, message] = mapping[code] || [502, '購入サービスへ接続できませんでした。'];
  return sendError(res, status, code, message);
}

function checkoutResultPage({ status, title, message }) {
  const isSuccess = status === 'success';
  const statusLabel = isSuccess ? 'PAYMENT COMPLETE' : 'PAYMENT CANCELED';
  const statusIcon = isSuccess ? '✓' : '—';
  const nextStep = isSuccess
    ? 'Mojidasへ戻り、アカウント画面の更新ボタンを押してください。'
    : 'Mojidasへ戻ると、そのまま引き続きご利用いただけます。';
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | Mojidas</title>
  <style>
    :root {
      --ink: #17272d;
      --muted: #5d7179;
      --brand: #078aa6;
      --brand-dark: #08657a;
      --brand-soft: #eaf7fa;
      --line: #d9e3e6;
      --canvas: #f4f7f8;
      --success: #1f7453;
      --success-soft: #e9f6ef;
      --warning: #8a5b00;
      --warning-soft: #fff7e4;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: var(--ink); background: linear-gradient(180deg, #fff 0%, #eef9fa 100%); }
    header { height: 68px; background: rgba(255,255,255,.94); border-bottom: 1px solid rgba(195,209,213,.85); }
    .header-inner { display: flex; align-items: center; max-width: 1160px; height: 100%; margin: 0 auto; padding: 0 24px; }
    .brand { display: inline-flex; align-items: center; text-decoration: none; }
    .brand img { display: block; width: 126px; height: auto; }
    main { display: grid; place-items: center; min-height: calc(100vh - 68px); padding: 56px 24px; }
    .result-card { width: min(680px, 100%); padding: 48px; background: #fff; border: 1px solid var(--line); border-radius: 22px; box-shadow: 0 18px 50px rgba(20,56,66,.1); }
    .status-icon { display: grid; place-items: center; width: 58px; height: 58px; margin-bottom: 22px; color: var(--success); background: var(--success-soft); border-radius: 18px; font-size: 28px; font-weight: 900; }
    .result-card.cancel .status-icon { color: var(--warning); background: var(--warning-soft); }
    .eyebrow { margin: 0 0 8px; color: var(--brand-dark); font-size: 12px; font-weight: 850; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 0 0 14px; font-size: clamp(30px, 5vw, 42px); line-height: 1.35; letter-spacing: -.025em; }
    .message { margin: 0; color: var(--muted); font-size: 17px; line-height: 1.9; }
    .next-step { display: grid; grid-template-columns: auto 1fr; gap: 4px 18px; margin-top: 28px; padding: 20px 22px; background: var(--brand-soft); border-radius: 14px; }
    .next-step strong { grid-row: 1 / 3; align-self: center; color: var(--brand-dark); font-size: 14px; }
    .next-step span { color: var(--ink); line-height: 1.7; }
    .close-note { margin: 18px 2px 0; color: var(--muted); font-size: 13px; }
    @media (max-width: 560px) {
      header { height: 62px; }
      .header-inner { padding: 0 18px; }
      .brand img { width: 108px; }
      main { min-height: calc(100vh - 62px); padding: 28px 18px; }
      .result-card { padding: 30px 24px; border-radius: 18px; }
      .status-icon { width: 52px; height: 52px; margin-bottom: 19px; border-radius: 15px; }
      .message { font-size: 15px; }
      .next-step { grid-template-columns: 1fr; gap: 4px; padding: 18px; }
      .next-step strong { grid-row: auto; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-inner">
      <a class="brand" href="https://app.mojidas.jp/" aria-label="Mojidas トップへ">
        <img src="/assets/mojidas-logo.png" alt="Mojidas">
      </a>
    </div>
  </header>
  <main>
    <section class="result-card ${isSuccess ? 'success' : 'cancel'}" aria-labelledby="result-title">
      <div class="status-icon" aria-hidden="true">${statusIcon}</div>
      <p class="eyebrow">${statusLabel}</p>
      <h1 id="result-title">${title}</h1>
      <p class="message">${message}</p>
      <div class="next-step"><strong>次の操作</strong><span>${nextStep}</span></div>
      <p class="close-note">確認が終わったら、このページは閉じてかまいません。</p>
    </section>
  </main>
</body>
</html>`;
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
    EMAIL_ALREADY_VERIFIED: [409, 'メールアドレスはすでに確認済みです。ログインしてください。'],
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
module.exports.sendDictionaryError = sendDictionaryError;
module.exports.sendBillingError = sendBillingError;
module.exports.checkoutResultPage = checkoutResultPage;
