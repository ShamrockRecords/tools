var express = require('express');
var https = require('https');
const crypto = require('crypto');
const {
  AdminAuthConfigurationError,
  createAdminCredentialVerifier,
} = require('../modules/auth/admin_credentials');
const { createMemoryRateLimiter } = require('../modules/auth/memory_rate_limiter');
const mojidasAdminUserStore = require('../modules/auth/mojidas_admin_user_store');
const mojidasPaidBalanceStore = require('../modules/billing/mojidas_paid_balance_store');
const mojidasVersionStore = require('../modules/mojidas_version_store');

var router = express.Router();

const LEGACY_FIREBASE_COOKIE_NAME = 'sessionCookie';
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 1500;
const SENDGRID_BATCH_SIZE = 500;
const MOJIDAS_USER_PAGE_SIZE = 20;
let adminCredentialVerifier = null;
const adminLoginRateLimit = createMemoryRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyPrefix: 'server-admin-login',
  onLimit(req, res, retryAfterSeconds) {
    req.session.adminError = `ログイン試行回数が多すぎます。約${Math.ceil(retryAfterSeconds / 60)}分後にお試しください。`;
    return res.redirect('/admin');
  },
});

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

async function getSessionUser(req) {
  return req.session && req.session.adminUser
    ? req.session.adminUser
    : null;
}

async function resolveUserRecord(sessionUser) {
  if (!sessionUser) {
    return null;
  }

  return {
    email: sessionUser.email,
    uid: 'server-admin',
    metadata: {
      lastSignInTime: sessionUser.signedInAt,
    },
  };
}

async function createAdminSession(adminUser, req, res) {
  await regenerateSession(req);
  req.session.adminUser = {
    email: adminUser.email,
    signedInAt: new Date().toISOString(),
  };
  req.session.cookie.maxAge = SESSION_DURATION_MS;
  res.clearCookie(LEGACY_FIREBASE_COOKIE_NAME);
}

async function verifyAdminCredentials(email, password) {
  if (!adminCredentialVerifier) {
    adminCredentialVerifier = createAdminCredentialVerifier(process.env);
  }
  return adminCredentialVerifier(email, password);
}

async function ensureAdmin(req, res, next) {
  try {
    const sessionUser = await getSessionUser(req);

    if (!sessionUser) {
      req.session.adminError = 'ログインしてください。';
      return res.redirect('/admin');
    }

    req.adminUser = sessionUser;
    return next();
  } catch (error) {
    return next(error);
  }
}

function getMojidasAdminUserStore(req) {
  return req.app.locals.mojidasAdminUserStore || mojidasAdminUserStore;
}

function getMojidasPaidBalanceStore(req) {
  return req.app.locals.mojidasPaidBalanceStore || mojidasPaidBalanceStore;
}

function getMojidasVersionStore(req) {
  return req.app.locals.mojidasVersionStore || mojidasVersionStore;
}

function consumeAdminFlash(req) {
  const flash = req.session.adminFlash || null;
  delete req.session.adminFlash;
  return flash;
}

function ensureAdminCSRFToken(req) {
  if (!req.session.adminCSRFToken) {
    req.session.adminCSRFToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.adminCSRFToken;
}

function hasValidAdminCSRFToken(req) {
  const expected = req.session.adminCSRFToken;
  const actual = typeof req.body.csrfToken === 'string' ? req.body.csrfToken : '';
  if (!expected || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function normalizeAdminPage(value) {
  const page = Number.parseInt(value, 10);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function formatAdminDate(value) {
  if (!value) return '情報なし';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '情報なし'
    : new Intl.DateTimeFormat('ja-JP', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Tokyo',
    }).format(date);
}

function getSendGridConfig() {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL;

  if (!apiKey || !fromEmail) {
    throw new Error('SendGridの設定が不足しています（SENDGRID_API_KEY / SENDGRID_FROM_EMAIL）。');
  }

  return { apiKey, fromEmail };
}

function sendGridRequest({ recipients, subject, body, apiKey, fromEmail }) {
  const payload = JSON.stringify({
    personalizations: recipients.map((email) => ({
      to: [{ email }],
    })),
    from: { email: fromEmail },
    subject,
    content: [
      { type: 'text/plain', value: body },
    ],
  });

  const options = {
    hostname: 'api.sendgrid.com',
    path: '/v3/mail/send',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  return new Promise((resolve, reject) => {
    const request = https.request(options, (response) => {
      let bodyText = '';

      response.on('data', (chunk) => {
        bodyText += chunk;
      });

      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
        } else {
          reject(
            new Error(
              `SendGrid API error (${response.statusCode}): ${bodyText || response.statusMessage}`
            )
          );
        }
      });
    });

    request.on('error', (error) => reject(error));

    request.write(payload);
    request.end();
  });
}

async function sendBulkMail({ recipients, subject, body, apiKey, fromEmail }) {
  for (let i = 0; i < recipients.length; i += SENDGRID_BATCH_SIZE) {
    const batch = recipients.slice(i, i + SENDGRID_BATCH_SIZE);
    await sendGridRequest({ recipients: batch, subject, body, apiKey, fromEmail });
  }
}

router.get('/', async function (req, res, next) {
  try {
    const sessionUser = await getSessionUser(req);

    if (!sessionUser) {
      const message = req.session.adminError || null;
      delete req.session.adminError;

      return res.render('admin/login', {
        error: message,
      });
    }

    const userRecord = await resolveUserRecord(sessionUser);

    return res.render('admin/dashboard', {
      user: userRecord,
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/bulk-mail', ensureAdmin, async function (req, res, next) {
  try {
    const userRecord = await resolveUserRecord(req.adminUser);

    return res.render('admin/bulk-mail', {
      user: userRecord,
      flash: null,
      form: { recipients: '', subject: '', body: '' },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/mojidas-users', ensureAdmin, async function (req, res, next) {
  try {
    const page = normalizeAdminPage(req.query.page);
    if (page === 1 || !req.session.mojidasUserPageTokens) {
      req.session.mojidasUserPageTokens = { 1: null };
    }
    const pageToken = req.session.mojidasUserPageTokens[page];
    if (page > 1 && !pageToken) {
      req.session.adminFlash = {
        type: 'warning',
        message: 'ページ情報が期限切れになったため、最初のページへ戻りました。',
      };
      return res.redirect('/admin/mojidas-users?page=1');
    }

    const result = await getMojidasAdminUserStore(req).listUsers({
      pageToken,
      pageSize: MOJIDAS_USER_PAGE_SIZE,
    });
    if (result.nextPageToken) {
      req.session.mojidasUserPageTokens[page + 1] = result.nextPageToken;
    } else {
      delete req.session.mojidasUserPageTokens[page + 1];
    }

    return res.render('admin/mojidas-users', {
      user: await resolveUserRecord(req.adminUser),
      users: result.users,
      page,
      hasNext: Boolean(result.nextPageToken),
      csrfToken: ensureAdminCSRFToken(req),
      flash: consumeAdminFlash(req),
      formatDate: formatAdminDate,
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/mojidas-paid-balance', ensureAdmin, async function (req, res, next) {
  try {
    return res.render('admin/mojidas-paid-balance', {
      user: await resolveUserRecord(req.adminUser),
      report: await getMojidasPaidBalanceStore(req).getReport(),
      formatDate: formatAdminDate,
      formatJPY(value, maximumFractionDigits = 0) {
        return new Intl.NumberFormat('ja-JP', {
          style: 'currency',
          currency: 'JPY',
          maximumFractionDigits,
        }).format(value);
      },
      formatDuration(milliseconds) {
        const totalMinutes = Math.floor((Number(milliseconds) || 0) / 60000);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return hours > 0 ? `${hours.toLocaleString('ja-JP')}時間${minutes}分` : `${minutes}分`;
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/mojidas-versions', ensureAdmin, async function (req, res, next) {
  try {
    const versions = await getMojidasVersionStore(req).getVersions();
    const form = req.session.mojidasVersionForm || {
      macOSVersion: versions.macOSVersion,
      windowsVersion: versions.windowsVersion,
    };
    delete req.session.mojidasVersionForm;

    return res.render('admin/mojidas-versions', {
      user: await resolveUserRecord(req.adminUser),
      form,
      updatedAt: versions.updatedAt,
      csrfToken: ensureAdminCSRFToken(req),
      flash: consumeAdminFlash(req),
      formatDate: formatAdminDate,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/mojidas-versions', ensureAdmin, async function (req, res, next) {
  if (!hasValidAdminCSRFToken(req)) {
    req.session.adminFlash = {
      type: 'danger',
      message: '画面の有効期限が切れました。もう一度操作してください。',
    };
    return res.redirect(303, '/admin/mojidas-versions');
  }

  const form = {
    macOSVersion: typeof req.body.macOSVersion === 'string' ? req.body.macOSVersion.trim() : '',
    windowsVersion: typeof req.body.windowsVersion === 'string'
      ? req.body.windowsVersion.trim()
      : '',
  };

  try {
    await getMojidasVersionStore(req).setVersions(form);
    req.session.adminFlash = {
      type: 'success',
      message: 'Mojidasの公開バージョンを更新しました。',
    };
    return res.redirect(303, '/admin/mojidas-versions');
  } catch (error) {
    if (error && error.code === 'INVALID_VERSION') {
      req.session.mojidasVersionForm = form;
      req.session.adminFlash = { type: 'danger', message: error.message };
      return res.redirect(303, '/admin/mojidas-versions');
    }
    return next(error);
  }
});

router.post('/mojidas-users/:uid/invited-unlimited', ensureAdmin, async function (req, res, next) {
  const page = normalizeAdminPage(req.body.page);
  const redirectPath = `/admin/mojidas-users?page=${page}`;
  if (!hasValidAdminCSRFToken(req)) {
    req.session.adminFlash = {
      type: 'danger',
      message: '画面の有効期限が切れました。もう一度操作してください。',
    };
    return res.redirect(303, redirectPath);
  }

  const uid = typeof req.params.uid === 'string' ? req.params.uid.trim() : '';
  if (!uid || uid.length > 128) {
    req.session.adminFlash = { type: 'danger', message: 'ユーザーIDが正しくありません。' };
    return res.redirect(303, redirectPath);
  }

  const enabled = req.body.enabled === 'true';
  try {
    await getMojidasAdminUserStore(req).setInvitedUnlimited({ uid, enabled });
    req.session.adminFlash = {
      type: 'success',
      message: enabled
        ? '招待ユーザーとして時間無制限に設定しました。'
        : '招待ユーザー設定を解除しました。',
    };
    return res.redirect(303, redirectPath);
  } catch (error) {
    return next(error);
  }
});

router.post('/login', adminLoginRateLimit, async function (req, res) {
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';

  if (!email || !password) {
    req.session.adminError = 'メールアドレスとパスワードを入力してください。';
    return res.redirect('/admin');
  }

  try {
    const adminUser = await verifyAdminCredentials(email, password);
    if (!adminUser) {
      req.session.adminError = 'メールアドレスまたはパスワードが正しくありません。';
      return res.redirect('/admin');
    }

    await createAdminSession(adminUser, req, res);
    return res.redirect('/admin');
  } catch (error) {
    req.session.adminError = error instanceof AdminAuthConfigurationError
      ? '管理者ログインのサーバー設定が完了していません。'
      : 'ログインに失敗しました。';
    return res.redirect('/admin');
  }
});

router.post('/bulk-mail', ensureAdmin, async function (req, res) {
  const recipientsRaw = req.body.recipients || '';
  const subject = (req.body.subject || '').trim();
  const body = (req.body.body || '').trim();

  const parsedRecipients = recipientsRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!parsedRecipients.length) {
    return res.status(400).json({
      success: false,
      message: '送信先メールアドレスを1件以上入力してください。',
    });
  }
  
  const invalidEmails = [];
  const duplicates = [];
  const recipients = [];
  const seen = new Set();

  for (const email of parsedRecipients) {
    if (!EMAIL_REGEX.test(email)) {
      invalidEmails.push(email);
      continue;
    }

    if (seen.has(email)) {
      duplicates.push(email);
      continue;
    }

    seen.add(email);
    recipients.push(email);
  }

  if (!recipients.length) {
    return res.status(400).json({
      success: false,
      message: '有効なメールアドレスがありません。',
    });
  }

  if (recipients.length > MAX_RECIPIENTS) {
    return res.status(400).json({
      success: false,
      message: `送信先は最大${MAX_RECIPIENTS}件までです。（現在: ${recipients.length}件）`,
    });
  }

  if (invalidEmails.length) {
    return res.status(400).json({
      success: false,
      message: `メールアドレスの形式が正しくありません: ${invalidEmails.join(', ')}`,
    });
  }

  if (!subject) {
    return res.status(400).json({
      success: false,
      message: '件名を入力してください。',
    });
  }

  if (!body) {
    return res.status(400).json({
      success: false,
      message: '本文を入力してください。',
    });
  }

  try {
    const { apiKey, fromEmail } = getSendGridConfig();

    await sendBulkMail({
      recipients,
      subject,
      body,
      apiKey,
      fromEmail,
    });

    return res.json({
      success: true,
      message: `${recipients.length}件のメール送信を開始しました${duplicates.length ? `（重複 ${duplicates.length}件を除外）` : ''}。`,
    });
  } catch (error) {
    console.error('[SendGrid] bulk-mail failed:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'メール送信に失敗しました。',
    });
  }
});

router.post('/logout', async function (req, res) {
  try {
    await destroySession(req);
  } catch (error) {
    return res.status(500).json({ result: false });
  }

  res.clearCookie('connect.sid');
  res.clearCookie(LEGACY_FIREBASE_COOKIE_NAME);
  return res.json({ result: true });
});

module.exports = router;
