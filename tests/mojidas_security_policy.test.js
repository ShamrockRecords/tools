const assert = require('assert');
const express = require('express');
const { EventEmitter } = require('events');
const { request, listen } = require('./partner_http_helper');
const { TransactionalFirestore } = require('./mojidas_credit_integrity.test');
const { MojidasCreditStore } = require('../modules/credit/mojidas_credit_store');
const { MojidasSecurityPolicy } = require('../modules/auth/mojidas_security_policy');
const { createMojidasRouter } = require('../routes/api/mojidas');

const ROOT = 'Mojidas/production/';
const date = Date.parse('2026-10-26T15:00:00Z');
const environment = {
  MOJIDAS_RESTRICTED_USER_IDS: 'uid-target',
  MOJIDAS_RESTRICTED_EMAIL_DOMAINS: ' suspicious.example ',
  MOJIDAS_SECURITY_WATCH_IPS: '203.0.113.7',
};
const fixtureUser = (uid, email) => ({ uid, email, emailVerified: true, disabled: false,
  metadata: { creationTime: new Date(date).toISOString() } });
const publicUser = user => ({ id: user.uid, email: user.email, emailVerified: user.emailVerified });
const dataState = db => structuredClone(new Map([...db.collections].filter(([name]) => !name.endsWith('/securityEvents'))));
const flush = async policy => { await new Promise(resolve => setImmediate(resolve)); await Promise.all(policy.pendingWrites); };

async function integration() {
  const db = new TransactionalFirestore(), logs = [], warnings = [], calls = [];
  const policy = new MojidasSecurityPolicy({ environment, firestoreProvider: () => db, now: () => date,
    log: event => logs.push(event), warn: value => warnings.push(value) });
  const users = {
    watched: fixtureUser('domain-target', 'test@suspicious.example'),
    uid: fixtureUser('uid-target', 'changed@ordinary.example'),
    normal: fixtureUser('normal', 'person@ordinary.example'),
  };
  const credits = new MojidasCreditStore({ firestoreProvider: () => db, now: () => date });
  const account = user => ({ userID: user.uid, accountCreatedAt: user.metadata.creationTime });
  const oldReservations = {};
  for (const [key, user] of Object.entries(users)) {
    oldReservations[key] = await credits.createReservation({ ...account(user), operation: 'mediaFile',
      clientSessionID: 'old-' + key, recognitionRunID: 'old-' + key, requestedMilliseconds: 60000, trackCount: 1 });
  }
  const session = user => ({ user: publicUser(user), accessToken: 'SECRET_ACCESS', refreshToken: 'SECRET_REFRESH', expiresIn: 3600 });
  const authClient = {
    async verifyAccessToken(token) {
      if (!users[token]) throw Object.assign(new Error('invalid'), { code: 'ID_TOKEN_REVOKED' });
      return users[token];
    },
    async register(email) { return { id: 'new-target', email, emailVerified: false }; },
    async login(email, password) {
      if (password !== 'password123') throw Object.assign(new Error('invalid'), { code: 'INVALID_PASSWORD' });
      return session(Object.values(users).find(user => user.email === email));
    },
    async refresh() { return session(users.watched); },
    async confirmEmailCode() { return session(users.watched); },
    async resendVerificationCode() { return { verificationRequired: true }; },
    async sendPasswordReset() {},
    publicUser,
  };
  const app = express();
  app.set('trust proxy', 1);
  app.use(policy.observe);
  app.use(express.json());
  app.get('/corporate', (req, res) => res.json({ login: true }));
  app.use('/api/mojidas', createMojidasRouter({
    authClient, securityPolicy: policy, creditStore: credits,
    userStore: { async recordLogin() {}, async recordClientInfo() {} },
    accountDeletionService: { async isEmailDeleted() { return false; }, async deleteAccount() { calls.push('delete'); return { deleted: true }; } },
    apiKeyIssuer: { async issue() { calls.push('key'); return { appKey: 'SECRET_APPKEY', expiresAt: null }; } },
    billingService: { async createCheckoutSession() { calls.push('checkout'); return { url: 'https://checkout.invalid' }; } },
    translationService: {
      async translateRealtime() { calls.push('realtime'); return { text: 'translated' }; },
      async estimateFormal() { return { billableMilliseconds: 1000 }; },
      async listSupportedLanguages() { return { languages: [] }; },
    },
    formalTranslationJobStore: {
      start() { calls.push('formal'); return { id: 'job-1', status: 'pending' }; },
      get() { return { id: 'job-1', status: 'completed', result: {} }; },
    },
  }));
  const server = await listen(app);
  const post = (path, body, token = 'watched', headers) => request(server, '/api/mojidas' + path,
    { method: 'POST', body, token, headers });
  try {
    const authBefore = structuredClone(users);
    assert.equal((await post('/auth/register', { email: 'new@suspicious.example', password: 'password123' })).status, 201);
    assert.equal((await post('/auth/login', { email: users.watched.email, password: 'password123' })).status, 200);
    assert.equal((await post('/auth/login', { email: users.watched.email, password: 'SECRET_PASSWORD' })).status, 401);
    assert.equal((await post('/auth/refresh', { refreshToken: 'SECRET_REFRESH' })).status, 200);
    assert.equal((await post('/auth/verify-email', { email: users.watched.email, code: '123456' })).status, 200);
    assert.equal((await post('/auth/verification/resend', { email: users.watched.email, password: 'password123' })).status, 200);
    assert.equal((await post('/auth/password-reset', { email: users.watched.email })).status, 202);
    assert.equal((await request(server, '/api/mojidas/me', { token: 'watched' })).status, 200);
    assert.equal((await request(server, '/api/mojidas/credits/balance', { token: 'watched' })).status, 200);
    assert.deepStrictEqual(users, authBefore, 'アカウント・認証情報を無効化・変更しない');

    const before = dataState(db);
    const blocked = [
      ['/usage/reservations', { mode: 'realtime', requestedMilliseconds: 0 }],
      ['/usage/reservations', { mode: 'mediaFile', requestedMilliseconds: 60000 }],
      ['/acp/instant-appkey', { reservationID: oldReservations.watched.id }],
      ['/translation/realtime', { text: 'SECRET_TRANSCRIPT' }],
      ['/translation/formal', { idempotencyKey: 'formal-1', segments: [{ text: 'SECRET_TRANSCRIPT' }] }],
      ['/billing/checkout-session', { productID: 'credit_60m_jpy' }],
    ];
    for (const token of ['watched', 'uid']) for (const [path, body] of blocked) {
      const result = await post(path, { ...body, userID: users.normal.uid, email: users.normal.email }, token,
        { 'X-Mojidas-Platform': 'macos', 'X-Mojidas-Version': '0.24.0', 'X-Forwarded-For': '198.51.100.9' });
      assert.equal(result.status, 403, path);
      assert.equal(result.body.error.code, 'USAGE_RESTRICTED');
      assert.equal(result.headers['cache-control'], 'no-store');
    }
    assert.deepStrictEqual(calls, [], '予約、外部キー、翻訳job、決済を作る前に拒否する');
    assert.deepStrictEqual(dataState(db), before, '拒否・再試行で残高・予約・台帳の内容と関係を変えない');
    assert.equal((await post('/acp/instant-appkey', {}, 'invalid')).status, 401, '検証失敗のトークンは権限を得ない');

    const finishBody = { consumedMilliseconds: 0 };
    assert.equal((await post('/usage/' + oldReservations.watched.id + '/cancel', finishBody)).status, 200);
    const finished = dataState(db);
    assert.equal((await post('/usage/' + oldReservations.watched.id + '/cancel', finishBody)).status, 200);
    assert.deepStrictEqual(dataState(db), finished, '制限前の予約取消は従来どおり冪等に精算する');
    assert.equal((await post('/usage/' + oldReservations.uid.id + '/complete', { consumedMilliseconds: 1000 }, 'uid')).status, 200);
    assert.equal((await post('/translation/formal/estimate', {})).status, 200);
    assert.equal((await request(server, '/api/mojidas/translation/formal/jobs/job-1', { token: 'watched' })).status, 200);

    assert.equal((await post('/acp/instant-appkey', { reservationID: oldReservations.normal.id }, 'normal')).status, 200);
    assert.equal((await post('/translation/realtime', {}, 'normal')).status, 200);
    assert.equal((await post('/translation/formal', { idempotencyKey: 'formal-1' }, 'normal')).status, 202);
    assert.equal((await post('/billing/checkout-session', {}, 'normal')).status, 201);
    assert.equal((await post('/usage/reservations', { mode: 'realtime', requestedMilliseconds: 0, trackCount: 1,
      clientSessionID: '11111111-1111-4111-8111-111111111111', recognitionRunID: '22222222-2222-4222-8222-222222222222' }, 'normal')).status, 201);
    assert.deepStrictEqual(calls, ['key', 'realtime', 'formal', 'checkout']);

    await request(server, '/corporate?token=SECRET_QUERY', { headers: {
      'X-Forwarded-For': '198.51.100.123, 203.0.113.7', Cookie: 'session=SECRET_COOKIE', 'User-Agent': 'test-client',
    } });
    await flush(policy);
    assert.equal(warnings.length, 0);
    assert.equal(logs.filter(event => event.route === '/corporate').length, 1);
    assert.equal(logs.find(event => event.route === '/corporate').sourceIP, '203.0.113.7', '転送ヘッダー先頭を信用しない');
    assert(!logs.some(event => event.userID === users.normal.uid), '通常アカウントを新たに追跡しない');
    assert(logs.some(event => event.identitySource === 'registered' && event.userID === 'new-target'));
    assert(logs.some(event => event.identitySource === 'unverified' && event.status === 401 && event.userID === null));
    assert(logs.some(event => event.userID === users.watched.uid && event.errorCode === 'USAGE_RESTRICTED'));
    assert.equal(db.records(ROOT + 'securityEvents').length, logs.length, '二重middlewareとfinish/closeで重複保存しない');
    assert(!JSON.stringify(logs).includes('SECRET_'), '本文、クエリ、Cookie、トークン、キーを監査に含めない');
    assert(logs.every(event => event.expiresAt - event.occurredAt === 30 * 86400000));
    assert.deepStrictEqual(users, authBefore);
    console.log('security policy: ログイン維持・費用操作拒否・通常利用・既存予約精算・監査の機密情報除外を確認');
  } finally { await new Promise(resolve => server.close(resolve)); }
}

async function lifecycle() {
  const warnings = [], logs = [];
  const p = new MojidasSecurityPolicy({ environment, log: x => logs.push(x), warn: x => warnings.push(x),
    firestoreProvider() { throw new Error('SECRET_DATABASE_FAILURE'); } });
  const user = fixtureUser('new-domain-user', 'UPPER@SUSPICIOUS.EXAMPLE');
  assert(p.restricted(user));
  assert(!p.restricted(fixtureUser('ordinary', 'user@suspicious.example.attacker.invalid')));
  assert(!new MojidasSecurityPolicy({ environment: {} }).restricted(user));
  assert(new MojidasSecurityPolicy({ environment }).restricted(user), '再起動後も同じ設定で制限する');
  for (const value of ['*', '@suspicious.example', 'bad/domain']) {
    assert.throws(() => new MojidasSecurityPolicy({ environment: { MOJIDAS_RESTRICTED_EMAIL_DOMAINS: value } }));
  }
  const req = { method: 'POST', originalUrl: '/api/mojidas/acp/instant-appkey', mojidasUser: user,
    ip: '203.0.113.7', route: { path: '/acp/instant-appkey' }, get: () => '', body: {} };
  const response = () => Object.assign(new EventEmitter(), {
    statusCode: 200, writableFinished: true,
    set() { return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; },
  });
  const res = response();
  p.observe(req, res, () => {});
  p.requireUsageAccess(req, res, () => assert.fail('制限を通過した'));
  res.emit('finish'); res.emit('close'); await flush(p);
  assert.equal(res.statusCode, 403, '監査DBが停止していても利用制限は継続する');
  assert.equal(warnings.length, 1);
  assert.equal(logs.length, 1, '保存失敗時も構造化サーバーログに残す');
  assert(!JSON.stringify(warnings).includes('SECRET_'));

  const aborted = response(); aborted.writableFinished = false;
  p.observe({ method: req.method, originalUrl: req.originalUrl, mojidasUser: user,
    ip: req.ip, route: req.route, get: req.get, body: {} }, aborted, () => {});
  aborted.emit('close'); await flush(p);
  assert(logs.at(-1).aborted); assert.equal(logs.at(-1).status, null);

  let now = date, writes = 0;
  const capped = new MojidasSecurityPolicy({ environment, now: () => now, log() {}, warn() {},
    firestoreProvider: () => ({ collection: () => ({ doc: () => ({ set: async () => { writes++; } }) }) }) });
  for (let i = 0; i < 140; i++) { capped.record({ eventID: String(i) }); await flush(capped); }
  assert.equal(writes, 120, '大量通信による監査への書込を1プロセス毎分120件までに制限');
  now += 60000; capped.record({ eventID: 'next-minute' }); await flush(capped); assert.equal(writes, 121);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const slow = new MojidasSecurityPolicy({ environment, log() {}, warn() {},
    firestoreProvider: () => ({ collection: () => ({ doc: () => ({ set: () => held }) }) }) });
  for (let i = 0; i < 50; i++) slow.record({ eventID: String(i) });
  assert.equal(slow.pendingWrites.size, 20, 'DB遅延時も監査の未完了書込を無制限に積まない');
  release(); await flush(slow); assert.equal(slow.pendingWrites.size, 0);
  console.log('security policy: 設定・再起動・監査障害・中断・記録上限を確認');
}

async function main() { await integration(); await lifecycle(); }
module.exports = main;
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
