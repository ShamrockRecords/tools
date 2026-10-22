const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { once } = require('events');
const { createMemoryRateLimiter } = require('../modules/auth/memory_rate_limiter');
const { createAdminPasswordHash } = require('../modules/auth/admin_credentials');
process.env.NODE_ENV = 'test';
process.env.ROOT_URL = 'http://localhost:3000';
process.env.FIREBASE_ADMIN_CREDENTIALS = '';
process.env.SESSION_SECRET = 'security-test-secret';
process.env.ADMIN_EMAIL = 'admin@example.invalid';
process.env.ADMIN_PASSWORD_HASH = createAdminPasswordHash('fixture-password-security');
process.env.LINE_CHANNEL_SECRET = 'fixture-line-secret';
process.env.LINE_KYODOSHI_CHANNEL_SECRET = 'fixture-kyodoshi-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'fixture-no-network';
process.env.LINE_KYODOSHI_CHANNEL_ACCESS_TOKEN = 'fixture-no-network';
const app = require('../app');

function request(server, path, { method = 'GET', body, cookie, headers = {}, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw === undefined ? body === undefined ? undefined : JSON.stringify(body) : raw;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...headers } }, res => {
      let text = ''; res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text,
        cookie: res.headers['set-cookie']?.find(c => c.startsWith('connect.sid='))?.split(';')[0] }));
    });
    req.on('error', reject); req.end(data);
  });
}

async function main() {
  const limited = createMemoryRateLimiter({ windowMs: 60000, max: 2, keyPrefix: 'fixture' });
  let accepted = 0, rejected = 0;
  for (let i = 0; i < 8; i++) limited({ ip: '192.0.2.10', get: () => `192.0.2.${i}`, socket: {} },
    { set() {}, status() { rejected++; return { json() {} }; } }, () => accepted++);
  assert.equal(accepted, 2); assert.equal(rejected, 6);
  let code, apiCalls = 0;
  app.locals.adminLoginMailer = { async send(message) { code = message.text.match(/\d{6}/)[0]; } };
  app.locals.summaryFetch = async (url, options) => {
    apiCalls++;
    assert.equal(JSON.parse(options.body).max_tokens, 2048);
    return { json: async () => ({ choices: [{ message: { content: '要約のテスト結果' } }] }) };
  };
  const line = require('@line/bot-sdk');
  const originalReply = line.messagingApi.MessagingApiClient.prototype.replyMessage;
  const originalFetch = global.fetch;
  const replies = [];
  global.fetch = async () => ({ json: async () => ({ choices: [{ message: { content: 'LINEのテスト結果' } }] }) });
  line.messagingApi.MessagingApiClient.prototype.replyMessage = async function(payload) { replies.push(payload); };
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    assert.equal((await request(server, '/youyaku')).status, 302);
    assert.equal((await request(server, '/youyaku/data', { method: 'POST', body: { lines: ['x'], command: 'x' }, headers: { Referer: 'http://localhost:3000.attacker.invalid' } })).status, 401);
    assert.equal(apiCalls, 0);
    for (const path of ['/line/debug', '/lineKyodoshi/debug']) assert.equal((await request(server, path, { method: 'POST', body: { prompt: 'test' } })).status, 401);
    let response = await request(server, '/admin/login', { method: 'POST', body: { email: process.env.ADMIN_EMAIL, password: 'fixture-password-security' } });
    let cookie = response.cookie;
    response = await request(server, '/admin', { cookie });
    const csrf = response.text.match(/name="csrf" value="([a-f0-9]+)"/)[1];
    response = await request(server, '/admin/verify-code', { method: 'POST', cookie, body: { csrf, code } });
    cookie = response.cookie;
    response = await request(server, '/youyaku', { cookie });
    assert.equal(response.status, 200);
    const token = response.text.match(/'X-CSRF-Token': "([a-f0-9]+)"/)[1];
    const body = { lines: ['入力'], command: '要約' };
    assert.equal((await request(server, '/youyaku/data', { method: 'POST', cookie, body })).status, 403);
    const headers = { 'X-CSRF-Token': token };
    response = await request(server, '/youyaku/data', { method: 'POST', cookie, body, headers });
    assert.equal(response.text, '要約のテスト結果'); assert.equal(apiCalls, 1);
    assert.equal((await request(server, '/youyaku/data', { method: 'POST', cookie, headers, body: { command: 'x', lines: ['x'.repeat(50001)] } })).status, 400);
    assert.equal(apiCalls, 1);
    assert.equal((await request(server, '/admin/login', { method: 'POST', body: { password: 'x'.repeat(1024 * 1024) } })).status, 413);
    // 大きな字幕を使う既存経路では1MB制限を適用しない。
    assert.notEqual((await request(server, '/srt2csv/not-found', { method: 'POST', body: { data: 'x'.repeat(1024 * 1024) } })).status, 413);
    for (const [path, secret] of [['/line/webhook', process.env.LINE_CHANNEL_SECRET], ['/lineKyodoshi/webhook', process.env.LINE_KYODOSHI_CHANNEL_SECRET]]) {
      const raw = JSON.stringify({ events: [{ type: 'message', replyToken: 'fixture-reply', message: { type: 'text', text: 'hello' } }] });
      assert.equal((await request(server, path, { method: 'POST', raw })).status, 403);
      const signature = crypto.createHmac('sha256', secret).update(raw).digest('base64');
      assert.equal((await request(server, path, { method: 'POST', raw: raw + ' ', headers: { 'x-line-signature': signature } })).status, 403);
      assert.equal((await request(server, path, { method: 'POST', raw, headers: { 'x-line-signature': signature } })).status, 200);
    }
    assert.equal(replies.length, 2);
    assert.equal(replies[0].messages[0].text, 'LINEのテスト結果');
    for (let i = 2; i < 120; i++) assert.equal((await request(server, '/youyaku/data', { method: 'POST', cookie, body, headers })).status, 200);
    assert.equal((await request(server, '/youyaku/data', { method: 'POST', cookie, body, headers })).status, 429);
    console.log('セキュリティ検証: IP偽装、認証、CSRF、入力制限、利用回数制限、LINE署名とSDK返信を確認（外部通信なし）');
  } finally {
    global.fetch = originalFetch;
    line.messagingApi.MessagingApiClient.prototype.replyMessage = originalReply;
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
