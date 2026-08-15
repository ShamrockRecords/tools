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

    response = await request(server, 'GET', '/admin/bulk-mail', { cookie });
    assert.strictEqual(response.status, 200);

    response = await request(server, 'POST', '/admin/logout', { cookie });
    assert.strictEqual(response.status, 200);

    response = await request(server, 'GET', '/admin/bulk-mail', { cookie });
    assert.strictEqual(response.status, 302);

    console.log('admin auth API tests passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
