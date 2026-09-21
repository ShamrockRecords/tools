const assert = require('assert');
const http = require('http');
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'isolated-root-redirect-test';
const app = require('../app');

function request(server, host, path = '/', method = 'GET', extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path, method, headers: { Host: host, ...extraHeaders } }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function main() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    for (const host of ['app.mojidas.jp', 'APP.MOJIDAS.JP', 'app.mojidas.jp:443']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await request(server, host, '/?next=https://example.com', method);
        assert.strictEqual(response.status, 302);
        assert.strictEqual(response.location, 'https://mojidas.jp/');
        assert.strictEqual(response.headers['cache-control'], 'no-store');
      }
    }
    for (const host of ['tools.udtalk.jp', 'localhost', 'app.mojidas.jp.example.com']) {
      const response = await request(server, host, '/', 'GET', { 'X-Forwarded-Host': 'app.mojidas.jp' });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.location, undefined);
    }
    for (const path of ['/admin', '/partners', '/api/mojidas/redirect-test-not-found', '/jimakueditor/', '/jimakueditor4file/']) {
      const response = await request(server, 'app.mojidas.jp', path);
      assert.notStrictEqual(response.location, 'https://mojidas.jp/', path);
    }
    assert.notStrictEqual((await request(server, 'app.mojidas.jp', '/', 'POST')).location, 'https://mojidas.jp/');
    console.log('Mojidasトップ限定リダイレクト・既存URL維持テスト成功');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
