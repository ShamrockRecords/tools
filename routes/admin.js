var express = require('express');
var https = require('https');
var firebase = require('firebase');
var firebaseAdmin = require('firebase-admin');

var router = express.Router();

const SESSION_COOKIE_NAME = 'sessionCookie';
const SESSION_DURATION_MS = 60 * 60 * 24 * 5 * 1000; // 5 days
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 1500;
const SENDGRID_BATCH_SIZE = 500;

function getFirebaseConfig() {
  return {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.MEASUREMENT_ID,
  };
}

function ensureFirebaseInitialized() {
  if (firebase.apps.length) {
    return true;
  }

  const config = getFirebaseConfig();

  if (!config.apiKey) {
    return false;
  }

  firebase.initializeApp(config);
  return true;
}

async function getSessionUser(req) {
  const sessionCookie = req.cookies[SESSION_COOKIE_NAME];

  if (!sessionCookie) {
    return null;
  }

  try {
    const decoded = await firebaseAdmin.auth().verifySessionCookie(sessionCookie, true);
    req.session.user = decoded;
    return decoded;
  } catch (error) {
    req.session.user = null;
    return null;
  }
}

async function resolveUserRecord(sessionUser) {
  if (!sessionUser) {
    return null;
  }

  try {
    return await firebaseAdmin.auth().getUser(sessionUser.uid);
  } catch (error) {
    return sessionUser;
  }
}

async function createSessionFromIdToken(idToken, req, res) {
  const sessionCookie = await firebaseAdmin.auth().createSessionCookie(idToken, {
    expiresIn: SESSION_DURATION_MS,
  });

  const decoded = await firebaseAdmin.auth().verifySessionCookie(sessionCookie, true);
  req.session.user = decoded;

  res.cookie(SESSION_COOKIE_NAME, sessionCookie, {
    maxAge: SESSION_DURATION_MS,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
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

router.post('/login', async function (req, res) {
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';

  if (!email || !password) {
    req.session.adminError = 'メールアドレスとパスワードを入力してください。';
    return res.redirect('/admin');
  }

  if (!firebaseAdmin.apps.length) {
    req.session.adminError = 'Firebase Admin SDKの設定が完了していません。';
    return res.redirect('/admin');
  }

  try {
    if (!ensureFirebaseInitialized()) {
      req.session.adminError = 'Firebaseの設定が不足しているためログインできません。';
      return res.redirect('/admin');
    }

    const credential = await firebase.auth().signInWithEmailAndPassword(email, password);
    const idToken = await credential.user.getIdToken();

    await createSessionFromIdToken(idToken, req, res);
    await firebase.auth().signOut();

    return res.redirect('/admin');
  } catch (error) {
    req.session.adminError = error.message || 'ログインに失敗しました。';
    try {
      await firebase.auth().signOut();
    } catch (_) {
      // ignore
    }
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
  const sessionUser = req.session.user;
  const uid = sessionUser && (sessionUser.sub || sessionUser.uid);

  if (uid) {
    try {
      await firebaseAdmin.auth().revokeRefreshTokens(uid);
    } catch (error) {
      // Ignore revocation errors so logout can complete.
    }
  }

  req.session.user = null;
  res.clearCookie(SESSION_COOKIE_NAME);
  return res.json({ result: true });
});

module.exports = router;
