var express = require('express');
var https = require('https');
const {
  AdminAuthConfigurationError,
  createAdminCredentialVerifier,
} = require('../modules/auth/admin_credentials');
const { createMemoryRateLimiter } = require('../modules/auth/memory_rate_limiter');

var router = express.Router();

const LEGACY_FIREBASE_COOKIE_NAME = 'sessionCookie';
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 1500;
const SENDGRID_BATCH_SIZE = 500;
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
