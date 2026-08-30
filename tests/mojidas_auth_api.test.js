const assert = require('assert');
const http = require('http');
const express = require('express');

const { FirebaseAuthError } = require('../modules/auth/firebase_auth_rest');
const { createMojidasRouter } = require('../routes/api/mojidas');

async function request(server, method, path, body, headers = {}) {
  const address = server.address();
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method,
      path,
      headers: {
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        } : {}),
        ...headers,
      },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBody += chunk;
      });
      response.on('end', () => {
        const contentType = String(response.headers['content-type'] || '');
        resolve({
          status: response.statusCode,
          body: responseBody
            ? (contentType.includes('application/json') ? JSON.parse(responseBody) : responseBody)
            : null,
        });
      });
    });

    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function main() {
  const calls = [];
  let invitedUnlimited = false;
  const authClient = {
    async register(email) {
      calls.push(['register', email]);
      return { id: 'user-1', email, emailVerified: false };
    },
    async login(email) {
      calls.push(['login', email]);
      return {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 3600,
        user: { id: 'user-1', email, emailVerified: true },
      };
    },
    async refresh(refreshToken) {
      calls.push(['refresh', refreshToken]);
      return {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 3600,
        user: { id: 'user-1', email: 'user@example.com', emailVerified: true },
      };
    },
    async confirmEmailCode(email, code) {
      calls.push(['confirm-email-code', email, code]);
      return {
        accessToken: 'verified-access-token',
        refreshToken: 'verified-refresh-token',
        expiresIn: 3600,
        user: { id: 'user-1', email, emailVerified: true },
      };
    },
    async resendVerificationCode(email) {
      calls.push(['resend-verification', email]);
      return { verificationRequired: true };
    },
    async sendPasswordReset(email) {
      calls.push(['password-reset', email]);
      if (email === 'missing@example.com') {
        throw new FirebaseAuthError('EMAIL_NOT_FOUND', 'not found', 400);
      }
    },
    async verifyAccessToken(token) {
      calls.push(['verify', token]);
      if (token !== 'access-token') {
        throw new FirebaseAuthError('ID_TOKEN_REVOKED', 'revoked', 401);
      }
      return {
        uid: 'user-1',
        email: 'user@example.com',
        emailVerified: true,
        customClaims: invitedUnlimited ? { mojidasInvitedUnlimited: true } : {},
        metadata: { creationTime: '2026-08-14T01:00:00.000Z' },
      };
    },
    publicUser(user) {
      return { id: user.uid, email: user.email, emailVerified: user.emailVerified };
    },
  };
  const recordedUsers = [];
  const appKeyCalls = [];
  const reservationChecks = [];
  const creditCalls = [];
  const checkoutCalls = [];
  const dictionaryCalls = [];
  let reservationMode = 'realtime';
  const userStore = {
    async recordLogin(user) {
      recordedUsers.push(user);
    },
  };
  const apiKeyIssuer = {
    async issue(options) {
      appKeyCalls.push(options);
      return {
        appKey: 'test-instant-appkey-0123456789abcdef',
        expiresAt: '2026-08-14T01:02:00.000Z',
      };
    },
  };
  const creditStore = {
    async getBalance(value) {
      creditCalls.push(['balance', value]);
      return {
        isUnlimited: value.isUnlimited,
        availableMilliseconds: 2400000,
        expiringMilliseconds: 2400000,
        purchasedMilliseconds: 0,
        grants: [{
          id: 'monthly-grant',
          type: 'monthlyFree',
          remainingMilliseconds: 2400000,
          expiresAt: '2026-09-14T01:00:00.000Z',
        }],
        serverTime: '2026-08-14T01:00:00.000Z',
      };
    },
    async createReservation(value) {
      creditCalls.push(['reserve', value]);
      return {
        id: 'reservation-1',
        requestedMilliseconds: value.requestedMilliseconds,
        leaseExpiresAt: '2026-08-14T01:10:00.000Z',
      };
    },
    async heartbeat(value) {
      creditCalls.push(['heartbeat', value]);
    },
    async completeReservation(value) {
      creditCalls.push(['complete', value]);
    },
    async assertActiveReservation(value) {
      reservationChecks.push(value);
      return { mode: reservationMode };
    },
  };
  const billingService = {
    async createCheckoutSession(value) {
      checkoutCalls.push(value);
      return {
        checkoutSessionID: 'cs_test_mojidas',
        url: 'https://checkout.stripe.com/c/pay/cs_test_mojidas',
        expiresAt: '2026-08-14T02:00:00.000Z',
      };
    },
  };
  const dictionaryStore = {
    async getChanges(value) {
      dictionaryCalls.push(['changes', value]);
      return { revision: 3, updatedAt: null, changes: [] };
    },
    async synchronize(value) {
      dictionaryCalls.push(['sync', value]);
      return { revision: 4, acceptedThroughSequence: 1 };
    },
  };
  const serviceConfiguration = {
    schemaVersion: 1,
    monthlyFreeAllowanceMilliseconds: 1_800_000,
    products: [{
      id: 'credit_60m_jpy',
      label: '60分購入',
      milliseconds: 3_600_000,
      totalJPY: 330,
      currency: 'JPY',
    }],
  };
  const versionStore = {
    async getVersions() {
      return {
        schemaVersion: 1,
        macOSVersion: '1.2.3',
        windowsVersion: '4.5.6.7',
        updatedAt: new Date('2026-08-30T12:00:00.000Z'),
      };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/mojidas', createMojidasRouter({
    authClient,
    userStore,
    apiKeyIssuer,
    creditStore,
    dictionaryStore,
    billingService,
    serviceConfigurationProvider: () => serviceConfiguration,
    versionStore,
  }));
  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });

  try {
    let response = await request(server, 'GET', '/api/mojidas/me', undefined, {
      Host: 'tools.udtalk.jp',
    });
    assert.strictEqual(response.status, 404);
    assert.strictEqual(response.body.error.code, 'NOT_FOUND');

    response = await request(server, 'GET', '/api/mojidas/me', undefined, {
      Host: 'app.mojidas.jp',
    });
    assert.strictEqual(response.status, 401);

    response = await request(server, 'GET', '/api/mojidas/configuration');
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, serviceConfiguration);

    response = await request(server, 'GET', '/api/mojidas/version');
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, {
      schemaVersion: 1,
      macOSVersion: '1.2.3',
      windowsVersion: '4.5.6.7',
      updatedAt: '2026-08-30T12:00:00.000Z',
    });

    response = await request(server, 'GET', '/api/mojidas/billing/success');
    assert.strictEqual(response.status, 200);
    assert.match(response.body, /Mojidas/);
    assert.match(response.body, /\/assets\/mojidas-logo\.png/);
    assert.match(response.body, /PAYMENT COMPLETE/);
    assert.match(response.body, /購入を受け付けました/);
    assert.match(response.body, /次の操作/);

    response = await request(server, 'GET', '/api/mojidas/billing/cancel');
    assert.strictEqual(response.status, 200);
    assert.match(response.body, /PAYMENT CANCELED/);
    assert.match(response.body, /購入をキャンセルしました/);

    response = await request(server, 'POST', '/api/mojidas/auth/register', {
      email: ' User@Example.com ',
      password: 'password123',
    });
    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.body.user.email, 'user@example.com');
    assert.strictEqual(response.body.verificationRequired, true);

    response = await request(server, 'POST', '/api/mojidas/auth/register', {
      email: 'user@example.com',
      password: 'short',
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.error.code, 'INVALID_PASSWORD');

    response = await request(server, 'POST', '/api/mojidas/auth/login', {
      email: 'user@example.com',
      password: 'password123',
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.accessToken, 'access-token');
    assert.strictEqual(recordedUsers.length, 1);

    response = await request(server, 'POST', '/api/mojidas/auth/refresh', {
      refreshToken: 'refresh-token',
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.accessToken, 'new-access-token');

    response = await request(server, 'POST', '/api/mojidas/auth/verify-email', {
      email: 'User@Example.com',
      code: '123 456',
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.verified, true);
    assert.strictEqual(response.body.accessToken, 'verified-access-token');
    assert.strictEqual(response.body.refreshToken, 'verified-refresh-token');
    assert.deepStrictEqual(calls.find((call) => call[0] === 'confirm-email-code'), [
      'confirm-email-code',
      'user@example.com',
      '123456',
    ]);

    response = await request(server, 'POST', '/api/mojidas/auth/verify-email', {
      email: 'user@example.com',
      code: '12345',
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.error.code, 'INVALID_VERIFICATION_CODE');

    response = await request(server, 'POST', '/api/mojidas/auth/verification/resend', {
      email: 'user@example.com',
      password: 'password123',
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.verificationRequired, true);

    response = await request(server, 'GET', '/api/mojidas/me');
    assert.strictEqual(response.status, 401);

    response = await request(server, 'GET', '/api/mojidas/me', undefined, {
      Authorization: 'Bearer access-token',
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.user.id, 'user-1');

    response = await request(server, 'GET', '/api/mojidas/credits/balance', undefined, {
      Authorization: 'Bearer access-token',
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.availableMilliseconds, 2400000);
    assert.deepStrictEqual(response.body.configuration, serviceConfiguration);
    assert.deepStrictEqual(creditCalls[0], ['balance', {
      userID: 'user-1',
      accountCreatedAt: '2026-08-14T01:00:00.000Z',
      isUnlimited: false,
    }]);

    response = await request(
      server,
      'GET',
      '/api/mojidas/dictionary/changes?afterRevision=2',
      undefined,
      { Authorization: 'Bearer access-token' }
    );
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.revision, 3);

    response = await request(server, 'POST', '/api/mojidas/dictionary/sync', {
      deviceID: '11111111-1111-4111-8111-111111111111',
      mutations: [{
        sequence: 1,
        wordID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        operation: 'delete',
      }],
    }, {
      Authorization: 'Bearer access-token',
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.acceptedThroughSequence, 1);
    assert.deepStrictEqual(dictionaryCalls, [
      ['changes', { userID: 'user-1', afterRevision: 2 }],
      ['sync', {
        userID: 'user-1',
        deviceID: '11111111-1111-4111-8111-111111111111',
        mutations: [{
          sequence: 1,
          wordID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          operation: 'delete',
        }],
      }],
    ]);

    response = await request(server, 'POST', '/api/mojidas/billing/checkout-session', {
      productID: 'credit_60m_jpy',
    });
    assert.strictEqual(response.status, 401);

    response = await request(server, 'POST', '/api/mojidas/billing/checkout-session', {
      productID: 'credit_60m_jpy',
    }, {
      Authorization: 'Bearer access-token',
    });
    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.body.checkoutSessionID, 'cs_test_mojidas');
    assert.deepStrictEqual(checkoutCalls, [{
      userID: 'user-1',
      email: 'user@example.com',
      productID: 'credit_60m_jpy',
    }]);

    response = await request(server, 'POST', '/api/mojidas/usage/reservations', {
      mode: 'realtime',
      clientSessionID: '550e8400-e29b-41d4-a716-446655440000',
      recognitionRunID: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
      requestedMilliseconds: 0,
      trackCount: 1,
    }, {
      Authorization: 'Bearer access-token',
    });
    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.body.id, 'reservation-1');
    assert.strictEqual(creditCalls[1][1].isUnlimited, false);
    assert.strictEqual(creditCalls[1][1].requestedMilliseconds, 0);

    response = await request(server, 'POST', '/api/mojidas/usage/reservation-1/heartbeat', {
      sequence: 1,
      consumedMilliseconds: 15000,
    }, {
      Authorization: 'Bearer access-token',
    });
    assert.strictEqual(response.status, 200);

    response = await request(server, 'POST', '/api/mojidas/usage/reservation-1/complete', {
      consumedMilliseconds: 30000,
    }, {
      Authorization: 'Bearer access-token',
    });
    assert.strictEqual(response.status, 200);

    response = await request(server, 'POST', '/api/mojidas/usage/reservation-1/cancel', {
      consumedMilliseconds: 15000,
    }, {
      Authorization: 'Bearer access-token',
    });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(creditCalls.slice(2).map((call) => call[0]), [
      'heartbeat',
      'complete',
      'complete',
    ]);

    invitedUnlimited = true;
    response = await request(server, 'GET', '/api/mojidas/credits/balance', undefined, {
      Authorization: 'Bearer access-token',
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.isUnlimited, true);
    assert.strictEqual(creditCalls.at(-1)[1].isUnlimited, true);

    response = await request(server, 'POST', '/api/mojidas/auth/password-reset', {
      email: 'missing@example.com',
    });
    assert.strictEqual(response.status, 202);
    assert.match(response.body.message, /アカウントが存在する場合/);

    response = await request(server, 'POST', '/api/mojidas/acp/trial-appkey', {
      recognitionRunID: '550e8400-e29b-41d4-a716-446655440000',
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.appKey, 'test-instant-appkey-0123456789abcdef');
    assert.strictEqual(response.body.expiresAt, '2026-08-14T01:02:00.000Z');

    response = await request(server, 'POST', '/api/mojidas/acp/trial-appkey', {
      recognitionRunID: 'invalid',
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.error.code, 'INVALID_RECOGNITION_RUN_ID');

    response = await request(server, 'POST', '/api/mojidas/acp/instant-appkey', {
      reservationID: 'reservation-1',
    });
    assert.strictEqual(response.status, 401);

    response = await request(server, 'POST', '/api/mojidas/acp/instant-appkey', {
      reservationID: 'reservation-1',
    }, {
      Authorization: 'Bearer access-token',
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.appKey, 'test-instant-appkey-0123456789abcdef');
    assert.deepStrictEqual(reservationChecks, [{
      reservationID: 'reservation-1',
      userID: 'user-1',
    }]);
    assert.strictEqual(appKeyCalls.length, 2);
    assert.strictEqual(appKeyCalls[1], undefined);

    reservationMode = 'mediaFile';
    response = await request(server, 'POST', '/api/mojidas/acp/instant-appkey', {
      reservationID: 'reservation-1',
      purpose: 'mediaFile',
    }, {
      Authorization: 'Bearer access-token',
    });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(appKeyCalls[2], { expiryMilliseconds: 600000 });

    assert.deepStrictEqual(calls[0], ['register', 'user@example.com']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('Mojidas auth/APIキーAPI: media用キー期限を含むテストに成功しました。');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
