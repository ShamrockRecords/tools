const assert = require('assert');
const http = require('http');
const { createAdminPasswordHash } = require('../modules/auth/admin_credentials');

process.env.NODE_ENV = 'test';
process.env.ROOT_URL = 'http://localhost:3000';
process.env.SESSION_SECRET = 'test-session-secret-that-is-not-used-in-production';
process.env.ADMIN_EMAIL = 'admin@example.com';
process.env.ADMIN_PASSWORD_HASH = createAdminPasswordHash('correct horse battery staple');

const app = require('../app');

function request(server, method, path, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? new URLSearchParams(body).toString() : null;
    const address = server.address();
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (cookie) headers.Cookie = cookie;

    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      method,
      path,
      headers,
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: responseBody,
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sessionCookie(response) {
  const values = response.headers['set-cookie'] || [];
  const value = values.find((item) => item.startsWith('connect.sid='));
  return value ? value.split(';')[0] : null;
}

async function main() {
  const broadcastCalls = [];
  const broadcastID = '00000000-0000-4000-8000-000000000001';
  let broadcastJob;
  app.locals.mojidasBroadcastService = {
    async listRecent() { return broadcastJob ? [broadcastJob] : []; },
    async prepare(value) {
      broadcastCalls.push(['prepare', value]);
      broadcastJob = { ...value, id: broadcastID, status: 'draft', recipientCount: 1234,
        acceptedCount: 0, excludedCount: 0, skippedCount: 1, duplicateCount: 2, createdAt: new Date() };
      return broadcastJob;
    },
    async get(id) {
      if (id !== broadcastID || !broadcastJob) throw Object.assign(new Error('not found'), { code: 'BROADCAST_NOT_FOUND' });
      return broadcastJob;
    },
    async start(id, email) { broadcastCalls.push(['start', id, email]); broadcastJob.status = 'sending'; return broadcastJob; },
  };
  const adminUserCalls = [];
  app.locals.mojidasAdminUserStore = {
    async listUsers(value) {
      adminUserCalls.push(['list', value]);
      return {
        users: [{
          uid: 'user-1',
          email: 'user@example.com',
          emailVerified: true,
          disabled: false,
          createdAt: '2026-08-01T00:00:00.000Z',
          lastSignInAt: '2026-08-22T00:00:00.000Z',
          invitedUnlimited: false,
          credit: { monthlyFreeMilliseconds: 1800000, purchasedMilliseconds: 7200000, promotionalMilliseconds: 3600000, totalMilliseconds: 12600000, otherMilliseconds: 0 },
        }],
        nextPageToken: 'page-2-token',
      };
    },
    async addPromotionalHours(value) {
      adminUserCalls.push(['add', value]);
    },
    async setInvitedUnlimited(value) {
      adminUserCalls.push(['set', value]);
    },
  };
  app.locals.mojidasPaidBalanceStore = {
    async getReport() {
      return {
        asOf: new Date('2026-08-26T00:00:00.000Z'),
        promotional: { grantedMilliseconds: 3600000, consumedMilliseconds: 0, remainingMilliseconds: 3600000, expiredMilliseconds: 0, breakdown: [] },
        isComplete: true,
        unusedPaidBalanceJPY: 165,
        knownUnusedPaidBalanceJPY: 165,
        exactKnownAmountJPY: 165,
        totalRemainingMilliseconds: 1_800_000,
        valuedRemainingMilliseconds: 1_800_000,
        unvaluedRemainingMilliseconds: 0,
        purchaseGrantCount: 1,
        unvaluedGrantCount: 0,
        reportingThresholdJPY: 10_000_000,
        thresholdUsageRate: 165 / 10_000_000,
        breakdown: [{
          productID: 'credit_60m_jpy',
          label: '60分購入',
          grantCount: 1,
          remainingMilliseconds: 1_800_000,
          amountJPY: 165,
        }],
      };
    },
  };
  const versionCalls = [];
  app.locals.mojidasVersionStore = {
    async getVersions() {
      return {
        schemaVersion: 1,
        macOSVersion: '0.8.0',
        windowsVersion: '0.11.0.0',
        updatedAt: new Date('2026-08-30T12:00:00.000Z'),
      };
    },
    async setVersions(value) {
      versionCalls.push(value);
      return value;
    },
  };
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    let response = await request(server, 'GET', '/admin');
    assert.strictEqual(response.status, 200);
    assert.match(response.body, /管理ログイン/);

    response = await request(server, 'GET', '/admin', {
      cookie: 'sessionCookie=legacy-firebase-cookie',
    });
    assert.strictEqual(response.status, 200);
    assert.match(response.body, /管理ログイン/);

    response = await request(server, 'POST', '/admin/login', {
      body: { email: 'admin@example.com', password: 'incorrect password' },
    });
    assert.strictEqual(response.status, 302);

    response = await request(server, 'POST', '/admin/login', {
      body: {
        email: 'ADMIN@example.com',
        password: 'correct horse battery staple',
      },
    });
    assert.strictEqual(response.status, 302);
    const cookie = sessionCookie(response);
    assert.ok(cookie);

    response = await request(server, 'GET', '/admin', { cookie });
    assert.strictEqual(response.status, 200);
    assert.match(response.body, /admin@example\.com/);
    assert.match(response.body, /サーバー管理者アカウント/);
    assert.match(response.body, /Mojidasユーザー管理/);
    assert.match(response.body, /Mojidas有償・無償時間集計/);
    assert.match(response.body, /Mojidasバージョン管理/);

    response = await request(server, 'GET', '/admin/mojidas-versions', { cookie });
    assert.strictEqual(response.status, 200);
    assert.match(response.body, /value="0\.8\.0"/);
    assert.match(response.body, /value="0\.11\.0\.0"/);
    const versionCSRFMatch = response.body.match(/name="csrfToken" value="([a-f0-9]+)"/);
    assert.ok(versionCSRFMatch);

    response = await request(server, 'POST', '/admin/mojidas-versions', {
      cookie,
      body: {
        csrfToken: versionCSRFMatch[1],
        macOSVersion: '1.2.3',
        windowsVersion: '4.5.6.7',
      },
    });
    assert.strictEqual(response.status, 303);
    assert.deepStrictEqual(versionCalls, [{
      macOSVersion: '1.2.3',
      windowsVersion: '4.5.6.7',
    }]);

    response = await request(server, 'GET', '/admin/mojidas-paid-balance', { cookie });
    assert.strictEqual(response.status, 200);
    assert.match(response.body, /現在の参考残高/);
    assert.match(response.body, /￥165/);
    assert.match(response.body, /無償提供（プロモーション等）/);
    assert.match(response.body, /累計付与/);
    assert.match(response.body, /credit_60m_jpy/);

    response = await request(server, 'GET', '/admin/mojidas-users', { cookie });
    assert.strictEqual(response.status, 200);
    assert.match(response.body, /user@example\.com/);
    assert.match(response.body, /招待に設定/);
    const csrfMatch = response.body.match(/name="csrfToken" value="([a-f0-9]+)"/);
    assert.ok(csrfMatch);

    assert.match(response.body, /毎月の無料：0時間30分0秒/);
    assert.match(response.body, /有償購入：2時間0分0秒/);
    assert.match(response.body, /無償提供：1時間0分0秒/);
    assert.match(response.body, /合計：3時間30分0秒/);
    const operationID = response.body.match(/name="operationID" value="([a-f0-9-]+)"/)[1];
    response = await request(server, 'POST', '/admin/mojidas-users/user-1/promotional-hours', {
      cookie, body: { hours: '2', operationID },
    });
    assert.strictEqual(response.status, 303);
    assert.strictEqual(adminUserCalls.filter(call => call[0] === 'add').length, 0, 'CSRFなしでは付与しない');
    response = await request(server, 'POST', '/admin/mojidas-users/user-1/promotional-hours', {
      body: { csrfToken: csrfMatch[1], hours: '2', operationID },
    });
    assert.strictEqual(response.status, 302);
    assert.strictEqual(adminUserCalls.filter(call => call[0] === 'add').length, 0, '未ログインでは付与しない');
    response = await request(server, 'POST', '/admin/mojidas-users/user-1/promotional-hours', {
      cookie, body: { csrfToken: csrfMatch[1], hours: '2', operationID, page: '1' },
    });
    assert.strictEqual(response.status, 303);
    assert.deepStrictEqual(adminUserCalls.find(call => call[0] === 'add'), ['add', {
      uid: 'user-1', hours: '2', operationID, adminEmail: 'admin@example.com', reason: undefined,
    }]);

    response = await request(server, 'POST', '/admin/mojidas-users/user-1/invited-unlimited', {
      cookie,
      body: { csrfToken: csrfMatch[1], page: '1', enabled: 'true' },
    });
    assert.strictEqual(response.status, 303);
    assert.deepStrictEqual(adminUserCalls.find((call) => call[0] === 'set'), [
      'set',
      { uid: 'user-1', enabled: true },
    ]);

    response = await request(server, 'GET', '/admin/mojidas-mail', { cookie });
    assert.equal(response.status, 200);
    assert.match(response.body, /Mojidas全ユーザーへメール/);
    assert.match(response.body, /削除済みアカウントは除外/);
    response = await request(server, 'POST', '/admin/mojidas-mail/prepare', { cookie, body: { subject: '件名', body: '本文' } });
    assert.equal(response.status, 403);
    assert.equal(broadcastCalls.length, 0);
    response = await request(server, 'POST', '/admin/mojidas-mail/prepare', { cookie,
      body: { csrfToken: csrfMatch[1], subject: '<b>お知らせ</b>', body: '本文\n次の行' } });
    assert.equal(response.status, 303);
    assert.equal(response.headers.location, `/admin/mojidas-mail/${broadcastID}`);
    assert.equal(broadcastCalls[0][0], 'prepare');
    response = await request(server, 'GET', `/admin/mojidas-mail/${broadcastID}`, { cookie });
    assert.match(response.body, /全1234件へ送信/);
    assert.match(response.body, /&lt;b&gt;お知らせ&lt;\/b&gt;/);
    assert.equal(broadcastCalls.length, 1, '確認画面では送信しない');
    response = await request(server, 'GET', `/admin/mojidas-mail/${broadcastID}/edit`, { cookie });
    assert.equal(response.status, 200);
    assert.match(response.body, /本文\n次の行/);
    response = await request(server, 'POST', `/admin/mojidas-mail/${broadcastID}/send`, { cookie, body: {} });
    assert.equal(response.status, 403);
    response = await request(server, 'POST', `/admin/mojidas-mail/${broadcastID}/send`, { body: { csrfToken: csrfMatch[1] } });
    assert.equal(response.status, 302);
    assert.equal(broadcastCalls.length, 1);
    response = await request(server, 'POST', `/admin/mojidas-mail/${broadcastID}/send`, { cookie, body: { csrfToken: csrfMatch[1] } });
    assert.equal(response.status, 303);
    assert.deepStrictEqual(broadcastCalls[1], ['start', broadcastID, 'admin@example.com']);
    response = await request(server, 'GET', `/admin/mojidas-mail/${broadcastID}`, { cookie });
    assert.match(response.body, /http-equiv="refresh"/);
    assert(!response.body.includes('class="btn btn-danger"'), '処理中の画面には送信ボタンを出さない');

    response = await request(server, 'GET', '/admin/bulk-mail', { cookie });
    assert.strictEqual(response.status, 200);

    response = await request(server, 'POST', '/admin/logout', { cookie });
    assert.strictEqual(response.status, 200);

    response = await request(server, 'GET', '/admin/bulk-mail', { cookie });
    assert.strictEqual(response.status, 302);

    console.log('admin auth API tests passed');
  } finally {
    delete app.locals.mojidasAdminUserStore;
    delete app.locals.mojidasPaidBalanceStore;
    delete app.locals.mojidasVersionStore;
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
