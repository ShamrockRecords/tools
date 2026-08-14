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
        resolve({
          status: response.statusCode,
          body: responseBody ? JSON.parse(responseBody) : null,
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
      return { uid: 'user-1', email: 'user@example.com', emailVerified: true };
    },
    publicUser(user) {
      return { id: user.uid, email: user.email, emailVerified: user.emailVerified };
    },
  };
  const recordedUsers = [];
  const userStore = {
    async recordLogin(user) {
      recordedUsers.push(user);
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/mojidas', createMojidasRouter({ authClient, userStore }));
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

    response = await request(server, 'GET', '/api/mojidas/me');
    assert.strictEqual(response.status, 401);

    response = await request(server, 'GET', '/api/mojidas/me', undefined, {
      Authorization: 'Bearer access-token',
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.user.id, 'user-1');

    response = await request(server, 'POST', '/api/mojidas/auth/password-reset', {
      email: 'missing@example.com',
    });
    assert.strictEqual(response.status, 202);
    assert.match(response.body.message, /アカウントが存在する場合/);

    assert.deepStrictEqual(calls[0], ['register', 'user@example.com']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('Mojidas auth API: 9件のテストに成功しました。');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
