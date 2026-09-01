var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var firebaseAdmin = require('firebase-admin');
var crypto = require('crypto');
const {
  resolveMojidasApiBodyLimit,
} = require('./modules/config/mojidas_translation_config');

require('dotenv').config();

const firebaseProjectId = process.env.FIREBASE_PROJECT_ID;

function loadAdminCredentialFromEnv() {
  if (!process.env.FIREBASE_ADMIN_CREDENTIALS) {
    return null;
  }

  const rawValue = process.env.FIREBASE_ADMIN_CREDENTIALS.trim();
  const candidates = [rawValue];

  // Allow base64-encoded payloads to keep .env tidy.
  try {
    const decoded = Buffer.from(rawValue, 'base64').toString('utf8');
    if (decoded.startsWith('{')) {
      candidates.unshift(decoded);
    }
  } catch (error) {
    // not base64, ignore
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      // try next candidate
    }
  }

  console.warn('Failed to parse FIREBASE_ADMIN_CREDENTIALS. Admin features are disabled until the value contains valid JSON or base64-encoded JSON.');
  return null;
}

if (!firebaseAdmin.apps.length) {
  const credentialData = loadAdminCredentialFromEnv();

  if (credentialData) {
    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(credentialData),
      projectId: firebaseProjectId,
    });
  } else {
    console.warn('Firebase Admin SDK credentials are not set. Configure FIREBASE_ADMIN_CREDENTIALS to enable Mojidas authentication and Firestore endpoints.');
  }
}

var indexRouter = require('./routes/index');
var srtToCsvIndexRouter = require('./routes/srtToCsv/index');
var genReadingIndexRouter = require('./routes/genReading/index');
var genReadingExIndexRouter = require('./routes/genReading/index4ex');
var captionEditorIndexRouter = require('./routes/captionEditor/index');
var captionEditor4FileIndexRouter = require('./routes/captionEditor/index4File');
var appMapIndexRouter = require('./routes/appMap/index');
var localeChangeRouter = require('./routes/localeChange');
var youyakuIndexRouter = require('./routes/youyaku/index');
var lineIndexRouter = require('./routes/line/index');
var lineKyodoshiIndexRouter = require('./routes/lineKyodoshi/index');
var adminRouter = require('./routes/admin');
var mojidasApiRouter = require('./routes/api/mojidas');
var createMojidasStripeWebhookHandler = require('./modules/billing/mojidas_stripe_billing')
  .createStripeWebhookHandler;
//var authDoneRouter = require('./routes/authDone');
//var signinRouter = require('./routes/signin');

var app = express();

// Stripeは署名検証にJSON parse前のraw bodyを必要とするため、共通body parserより先に置く。
app.post(
  '/api/mojidas/billing/stripe/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  createMojidasStripeWebhookHandler()
);

app.use(function(req, res, next) {
  if (req.url == "/jimakueditor4file" || req.url == "/jimakueditor4file/") {
    res.header('Cross-Origin-Opener-Policy', 'same-origin') ;
    res.header('Cross-Origin-Embedder-Policy', 'require-corp') ;
  }
  
  next()
})

const session = require('express-session') ;

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set. Sessions will be invalidated whenever the process restarts.');
}

var session_opt = {
	secret: sessionSecret,
	resave: false,
	saveUninitialized: false,
	cookie: {
    maxAge: 60 * 60 * 24 * 7 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
} ;

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(session(session_opt)) ;

var i18n = require("i18n");
 
// 多言語化の利用設定
i18n.configure({
  // 利用するlocalesを設定。これが辞書ファイルとひも付きます
  locales: ['ja', 'en'],
  defaultLocale: 'en',
  // 辞書ファイルのありかを指定
  directory: __dirname + "/locales",
  // オブジェクトを利用したい場合はtrue
  objectNotation: true,
});
 
app.use(i18n.init);

// manualでi18nセッション管理できるように設定しておきます
app.use(function (req, res, next) {
  if (req.session.locale) {
    i18n.setLocale(req, req.session.locale);
  }
  next();
});

// Mojidasの正式翻訳は長時間ライブセッションの発話列と再利用情報を受け取る。
// 後段の既存Web機能向け100MB parserより先に、用途に十分な範囲で容量を制限する。
const mojidasApiBodyLimit = resolveMojidasApiBodyLimit();
const mojidasJsonParser = express.json({ limit: mojidasApiBodyLimit });
const mojidasUrlencodedParser = express.urlencoded({
  extended: false,
  limit: mojidasApiBodyLimit,
});
app.use('/api/mojidas', function (req, res, next) {
  mojidasJsonParser(req, res, function (jsonError) {
    if (jsonError) return sendMojidasBodyParserError(res, next, jsonError);
    return mojidasUrlencodedParser(req, res, function (urlencodedError) {
      if (urlencodedError) return sendMojidasBodyParserError(res, next, urlencodedError);
      return next();
    });
  });
});

app.use(express.json({limit: '100mb'}));
app.use(express.urlencoded({ extended: false, limit: '100mb' }));

if (process.env.ROOT_URL != "http://localhost:3000") {
  var secure = require('ssl-express-www');

  app.use(secure);
}

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(logger('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/srt2csv', srtToCsvIndexRouter);
app.use('/yomifuri', genReadingIndexRouter);
app.use('/yomifuri_ex', genReadingExIndexRouter);
app.use('/jimakueditor', captionEditorIndexRouter);
app.use('/jimakueditor4file', captionEditor4FileIndexRouter);
app.use('/appmap', appMapIndexRouter);
app.use('/locale_change', localeChangeRouter);
app.use('/youyaku', youyakuIndexRouter);
app.use('/line', lineIndexRouter);
app.use('/lineKyodoshi', lineKyodoshiIndexRouter);
app.use('/admin', adminRouter);
app.use('/api/mojidas', mojidasApiRouter);

function sendMojidasBodyParserError(res, next, error) {
  if (error && error.type === 'entity.too.large') {
    return res.status(413).json({
      error: {
        code: 'REQUEST_TOO_LARGE',
        message: 'リクエストサイズが上限を超えています。',
      },
    });
  }
  if (error && error.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'JSONの形式が正しくありません。',
      },
    });
  }
  return next(error);
}

//app.use('/authDone', authDoneRouter);
//app.use('/signin', signinRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
