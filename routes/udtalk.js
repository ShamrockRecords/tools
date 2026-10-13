const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { createMemoryRateLimiter } = require('../modules/auth/memory_rate_limiter');
const { ClaimError, MAX_IMAGE_BYTES, WordAccountClaimStore } = require('../modules/udtalk/word_account_claim_store');

const defaultStore = new WordAccountClaimStore();
const FORM_PATH = '/udtalk/word-account-claim';
const ADMIN_PATH = '/admin/udtalk-word-account-claims';

function createUdtalkRouter({ admin = false, store = defaultStore, rateLimitMax = 10 } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    req.setLocale(req.query.lang === 'en' ? 'en' : 'ja');
    res.set({
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    if (admin && !req.session.adminUser) return res.redirect('/admin');
    return next();
  });
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const t = req => key => req.__(`udtalk.claim.${key}`);
  const currentStore = req => req.app.locals.udtalkWordAccountClaimStore || store;

  if (admin) {
    router.get('/', wrap(async (req, res) => {
      const result = await currentStore(req).list(req.query.after);
      return res.render('admin/udtalk-word-account-claims', {
        ...result, t: t(req), language: req.getLocale(), base: ADMIN_PATH, formPath: FORM_PATH,
        hasCursor: !!req.query.after,
        formatDate(value) {
          const date = value?.toDate ? value.toDate() : new Date(value);
          return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tokyo' }).format(date);
        },
      });
    }));
    router.get('/:id/screenshot', wrap(async (req, res) => {
      const screenshot = await currentStore(req).screenshot(req.params.id);
      res.set('Content-Disposition', 'inline');
      return res.type(screenshot.contentType).send(screenshot.buffer);
    }));
  } else {
    function formSignature(req, id) {
      if (!req.session.udtalkClaimSecret) req.session.udtalkClaimSecret = crypto.randomBytes(32).toString('hex');
      return crypto.createHmac('sha256', req.session.udtalkClaimSecret).update(id).digest('hex');
    }
    function renderForm(req, res, { status = 200, error = '', values = {}, requestID = crypto.randomUUID() } = {}) {
      return res.status(status).render('udtalk/word-account-claim', {
        t: t(req), language: req.getLocale(), formPath: FORM_PATH, values, error,
        requestID, formToken: formSignature(req, requestID), receipt: null,
      });
    }
    router.get('/', (req, res) => renderForm(req, res));
    router.get('/complete', (req, res) => {
      if (!req.session.udtalkClaimReceipt) return res.redirect(FORM_PATH);
      return res.render('udtalk/word-account-claim', {
        t: t(req), language: req.getLocale(), formPath: FORM_PATH,
        receipt: req.session.udtalkClaimReceipt,
      });
    });
    const limited = createMemoryRateLimiter({
      windowMs: 15 * 60 * 1000, max: rateLimitMax, keyPrefix: 'udtalk-claim',
      keyGenerator: req => req.ip,
      onLimit: (req, res) => renderForm(req, res, { status: 429, error: t(req)('errors.rateLimit') }),
    });
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 11, parts: 13, fieldSize: 2048, fieldNameSize: 100 },
    }).single('screenshot');
    router.post('/', limited, (req, res, next) => {
      if (!req.is('multipart/form-data')) return renderForm(req, res, { status: 400, error: t(req)('errors.upload') });
      return upload(req, res, error => {
        if (error && !(error instanceof multer.MulterError)) {
          return renderForm(req, res, { status: 400, error: t(req)('errors.upload'), values: req.body || {} });
        }
        return next(error);
      });
    }, wrap(async (req, res) => {
      const { requestID, formToken } = req.body;
      if (typeof requestID !== 'string' || !/^[a-f0-9-]{36}$/.test(requestID)
          || typeof formToken !== 'string' || !/^[a-f0-9]{64}$/.test(formToken)
          || !req.session.udtalkClaimSecret
          || !crypto.timingSafeEqual(Buffer.from(formToken), Buffer.from(formSignature(req, requestID)))) {
        return renderForm(req, res, { status: 403, error: t(req)('errors.formExpired'), values: req.body });
      }
      try {
        const id = await currentStore(req).submit(formToken, req.body, req.file);
        req.session.udtalkClaimReceipt = id;
        await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
        return res.redirect(303, `${FORM_PATH}/complete${req.getLocale() === 'en' ? '?lang=en' : ''}`);
      } catch (error) {
        if (!(error instanceof ClaimError)) console.error('UDTalk申請の保存に失敗しました。', error.code || error.name);
        return renderForm(req, res, {
          status: error instanceof ClaimError ? error.status : 503,
          error: t(req)(`errors.${error instanceof ClaimError ? error.key : 'save'}`),
          values: req.body, requestID,
        });
      }
    }));
    router.use((error, req, res, next) => {
      if (!(error instanceof multer.MulterError)) return next(error);
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      return renderForm(req, res, {
        status: tooLarge ? 413 : 400,
        error: t(req)(`errors.${tooLarge ? 'imageSize' : 'upload'}`), values: req.body || {},
      });
    });
  }
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (!(error instanceof ClaimError)) console.error('UDTalk申請の取得に失敗しました。', error.code || error.name);
    return res.status(error instanceof ClaimError ? error.status : 503)
      .render('udtalk/error', { t: t(req), language: req.getLocale(), admin,
        message: t(req)(`errors.${error instanceof ClaimError ? error.key : 'load'}`),
        back: admin ? ADMIN_PATH : FORM_PATH });
  });
  return router;
}

module.exports = { createUdtalkRouter };
