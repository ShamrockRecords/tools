const crypto = require('crypto');
const { isIP } = require('net');
const { getFirestore } = require('../firestore');
const { mojidasCollection } = require('../mojidas_firestore');

const OBSERVED = Symbol('mojidasSecurityObserved');
const SUBJECT = Symbol('mojidasSecuritySubject');
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EVENTS_PER_MINUTE = 120;
const MAX_PENDING_WRITES = 20;

function list(value, valid, normalize = value => value) {
  const values = String(value || '').split(',').map(value => normalize(value.trim())).filter(Boolean);
  if (values.some(value => !valid(value))) throw new Error('Mojidas security policy configuration is invalid.');
  return new Set(values);
}

function emailDomain(email) {
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) return '';
  return email.slice(email.indexOf('@') + 1).toLowerCase();
}

function normalizeIP(value) {
  const address = String(value || '');
  return address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

class MojidasSecurityPolicy {
  constructor({ environment = process.env, firestoreProvider = getFirestore, now = Date.now,
    log = event => console.info('[MojidasSecurity]', JSON.stringify(event)),
    warn = message => console.warn('[MojidasSecurity]', message) } = {}) {
    this.userIDs = list(environment.MOJIDAS_RESTRICTED_USER_IDS, value => /^[A-Za-z0-9_-]{1,128}$/.test(value));
    this.domains = list(environment.MOJIDAS_RESTRICTED_EMAIL_DOMAINS,
      value => value.length <= 253 && value.includes('.')
        && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
      value => value.toLowerCase());
    this.ips = list(environment.MOJIDAS_SECURITY_WATCH_IPS, value => isIP(value) > 0, normalizeIP);
    this.firestoreProvider = firestoreProvider;
    this.now = now;
    this.log = log;
    this.warn = warn;
    this.pendingWrites = new Set();
    this.window = null;
    this.count = 0;
    this.limitReported = false;
    this.observe = this.observe.bind(this);
    this.requireUsageAccess = this.requireUsageAccess.bind(this);
  }

  restricted(user) {
    return Boolean(user && (this.userIDs.has(user.uid || user.id) || this.domains.has(emailDomain(user.email))));
  }

  identify(req, user, source) {
    req[SUBJECT] = { user, source };
  }

  requireUsageAccess(req, res, next) {
    // 本文・ヘッダーの自己申告ではなく、検証済みFirebaseユーザーだけで判定する。
    if (!req.mojidasUser) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '認証が必要です。' } });
    if (!this.restricted(req.mojidasUser)) return next();
    res.set('Cache-Control', 'no-store');
    return res.status(403).json({ error: {
      code: 'USAGE_RESTRICTED',
      message: 'このアカウントでは現在、音声認識・翻訳・時間の購入を利用できません。',
    } });
  }

  observe(req, res, next) {
    if (req[OBSERVED] || !(this.userIDs.size || this.domains.size || this.ips.size)) return next();
    req[OBSERVED] = true;
    const startedAt = this.now();
    const pathname = String(req.originalUrl || req.url || '').split('?')[0];
    const eventID = crypto.randomUUID();
    let errorCode = null;
    const json = res.json;
    res.json = function (body) {
      const code = body?.error?.code;
      if (typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code)) errorCode = code;
      return json.call(this, body);
    };
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      const authenticated = req.mojidasUser;
      const subject = authenticated ? { user: authenticated, source: 'authenticated' } : req[SUBJECT];
      // 認証失敗時のメールは自己申告。UIDに紐づけず、ドメインのみ記録する。
      const claimedDomain = /^\/api\/mojidas\/auth\/(register|login|verify-email|verification\/resend|password-reset)\/?$/i.test(pathname)
        ? emailDomain(req.body?.email) : '';
      const domain = subject ? emailDomain(subject.user.email) : claimedDomain;
      const address = normalizeIP(req.ip || req.socket?.remoteAddress);
      if (!(this.restricted(subject?.user) || this.domains.has(claimedDomain) || this.ips.has(address))) return;
      const time = this.now();
      const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
      const host = String(req.get('Host') || '').toLowerCase();
      const userAgent = String(req.get('User-Agent') || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
      this.record({
        eventID, occurredAt: new Date(time), expiresAt: new Date(time + RETENTION_MS),
        userID: subject?.user.uid || subject?.user.id || null,
        identitySource: subject?.source || 'unverified', emailDomain: domain || null,
        sourceIP: isIP(address) ? address : null,
        host: /^[a-z0-9.:[\]-]{1,253}$/.test(host) ? host : null,
        method: req.method, route, pathHash: crypto.createHash('sha256').update(pathname).digest('hex'),
        status: res.writableFinished ? res.statusCode : null, aborted: !res.writableFinished,
        errorCode, durationMilliseconds: Math.max(0, time - startedAt), userAgent,
      });
    };
    res.once('finish', record);
    res.once('close', record);
    next();
  }

  record(event) {
    const window = Math.floor(this.now() / 60000);
    if (this.window !== window) { this.window = window; this.count = 0; this.limitReported = false; }
    // 監査への大量書込・未完了Promiseの蓄積で、攻撃が追加費用やメモリ枯渇を招かないよう上限を設ける。
    if (this.count >= MAX_EVENTS_PER_MINUTE || this.pendingWrites.size >= MAX_PENDING_WRITES) {
      if (!this.limitReported) this.warn('Audit capacity reached; some events are omitted in this minute.');
      this.limitReported = true;
      return;
    }
    this.count++;
    this.log(event);
    const write = Promise.resolve().then(() => mojidasCollection(this.firestoreProvider(), 'securityEvents')
      .doc(event.eventID).set(event))
      .catch(() => this.warn('Audit persistence failed; see the structured server log.'))
      .finally(() => this.pendingWrites.delete(write));
    this.pendingWrites.add(write);
  }
}

module.exports = { MojidasSecurityPolicy, mojidasSecurityPolicy: new MojidasSecurityPolicy() };
