const assert = require('assert');
const http = require('http');
const { once } = require('events');
const { SendGridMailer } = require('../modules/email/sendgrid_mailer');
const {
  SERVICE_URL,
  ALERT_EMAIL,
  ServicePropertiesError,
  ServicePropertiesMonitor,
  fetchServiceProperties,
  validateServiceProperties,
} = require('../modules/monitoring/udtalk_service_properties');
const { main: runCommand } = require('../scripts/check_udtalk_service_properties');

async function testValidationAndNotifications() {
  const valid = Buffer.from('{"modeDatas":[],"latestVersion":"94","説明":"設定"}');
  validateServiceProperties(valid);
  validateServiceProperties(Buffer.from('\uFEFF{"value":1}'));
  const invalidBodies = ['', ' ', '{"value":1,}', '{"value":"secret-value}', '<html>error</html>'];
  for (const text of invalidBodies) {
    assert.throws(() => validateServiceProperties(Buffer.from(text)), error => {
      assert(!error.message.includes('secret-value'));
      return error.code === 'INVALID_JSON';
    });
  }
  for (const text of ['null', '[]', '[{}]', '{}', '42', 'true', '"value"']) {
    assert.throws(() => validateServiceProperties(Buffer.from(text)), { code: 'INVALID_STRUCTURE' });
  }
  assert.throws(() => validateServiceProperties(Buffer.from([0x7b, 0x22, 0xff])), { code: 'INVALID_ENCODING' });
  assert.throws(() => validateServiceProperties(Buffer.from('{\n"value":1,\n}')), error => {
    assert.match(error.message, /3行、1列/);
    return error.code === 'INVALID_JSON';
  });

  const outgoing = [];
  const mailer = new SendGridMailer({
    apiKey: 'test-key', fromEmail: 'test@example.com',
    requester: async ({ payload }) => { outgoing.push(payload); },
  });
  let body = valid;
  const options = {
    fetcher: async () => body, mailer, now: () => new Date('2026-09-18T00:00:00Z'),
  };
  const monitor = new ServicePropertiesMonitor(options);
  assert.strictEqual((await monitor.check()).ok, true);
  assert.strictEqual(outgoing.length, 0);
  body = Buffer.from('{"password":"secret-value",}');
  for (const instance of [monitor, monitor, new ServicePropertiesMonitor(options)]) {
    const result = await instance.check();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.notification, 'accepted');
    assert.strictEqual(result.error.code, 'INVALID_JSON');
  }
  assert.strictEqual(outgoing.length, 3);
  assert.deepStrictEqual(outgoing[0].personalizations, [{ to: [{ email: ALERT_EMAIL }] }]);
  const text = outgoing[0].content[0].value;
  assert(text.includes(SERVICE_URL));
  assert(text.includes('2026-09-18T00:00:00.000Z'));
  assert(text.includes('INVALID_JSON'));
  assert(!JSON.stringify(outgoing).includes('secret-value'));
  body = valid;
  assert.strictEqual((await monitor.check()).notification, 'not_needed');
  assert.strictEqual(outgoing.length, 3);

  for (const code of ['FETCH_TIMEOUT', 'HTTP_ERROR', 'FETCH_FAILED', 'RESPONSE_TOO_LARGE']) {
    const failureMonitor = new ServicePropertiesMonitor({ mailer,
      fetcher: async () => { throw new ServicePropertiesError(code, '取得エラー'); },
    });
    assert.strictEqual((await failureMonitor.check()).error.code, code);
  }
  assert.strictEqual(outgoing.length, 7);
  body = Buffer.from('broken');
  assert.strictEqual((await monitor.check({ notify: false })).notification, 'skipped');
  assert.strictEqual(outgoing.length, 7);

  const failingMailer = { send: async () => { throw new Error('private-api-key'); } };
  await assert.rejects(() => new ServicePropertiesMonitor({ ...options, mailer: failingMailer }).check(), error => {
    assert.strictEqual(error.code, 'ALERT_EMAIL_FAILED');
    assert.strictEqual(error.result.notification, 'failed');
    assert.strictEqual(error.result.error.code, 'INVALID_JSON');
    assert(!error.message.includes('private-api-key'));
    return true;
  });
  const saved = [process.env.SENDGRID_API_KEY, process.env.SENDGRID_FROM_EMAIL];
  try {
    for (const [key, from] of [['', 'test@example.com'], ['test-key', '']]) {
      process.env.SENDGRID_API_KEY = key;
      process.env.SENDGRID_FROM_EMAIL = from;
      const unconfigured = new ServicePropertiesMonitor({ fetcher: async () => valid });
      await assert.rejects(() => unconfigured.check(), { code: 'MONITOR_NOT_CONFIGURED' });
      assert.strictEqual((await unconfigured.check({ notify: false })).ok, true);
    }
  } finally {
    ['SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL'].forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  }
}

async function testTransport() {
  let handler;
  const sockets = new Set();
  const server = http.createServer((req, res) => handler(req, res));
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const request = (url, options, callback) => {
    assert.strictEqual(url, SERVICE_URL);
    return http.request(`http://127.0.0.1:${server.address().port}`, options, callback);
  };
  const fetcher = options => fetchServiceProperties({ request, ...options });
  try {
    handler = (req, res) => {
      assert.strictEqual(req.method, 'GET');
      assert.strictEqual(req.headers['cache-control'], 'no-cache, no-store');
      res.end('{"value":"正常"}');
    };
    validateServiceProperties(await fetcher());
    for (const status of [204, 301, 404, 500]) {
      handler = (_req, res) => { res.writeHead(status, { Location: '/redirect' }); res.end('{}'); };
      await assert.rejects(() => fetcher(), { code: 'HTTP_ERROR' });
    }
    handler = (_req, res) => res.end('x'.repeat(65));
    await assert.rejects(() => fetcher({ maxBytes: 64 }), { code: 'RESPONSE_TOO_LARGE' });
    handler = (_req, res) => { res.writeHead(200, { 'Content-Length': 100 }); res.end('{}'); };
    await assert.rejects(() => fetcher(), { code: 'FETCH_FAILED' });
    handler = (req, _res) => req.socket.destroy();
    await assert.rejects(() => fetcher(), { code: 'FETCH_FAILED' });
    handler = () => {};
    await assert.rejects(() => fetcher({ timeoutMs: 30 }), { code: 'FETCH_TIMEOUT' });
    handler = (_req, res) => {
      res.write('{');
      const timer = setInterval(() => res.write(' '), 5);
      res.on('close', () => clearInterval(timer));
    };
    await assert.rejects(() => fetcher({ timeoutMs: 40 }), { code: 'FETCH_TIMEOUT' });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

async function testCommand() {
  let outcome = { ok: true, notification: 'not_needed' };
  let options;
  const logs = [];
  const command = args => runCommand({ args, log: value => logs.push(JSON.parse(value)), monitor: {
    check: async value => { options = value; return outcome; },
  } });
  assert.strictEqual(await command([]), 0);
  assert.deepStrictEqual(options, { notify: true });
  outcome = { ok: false, notification: 'accepted' };
  assert.strictEqual(await command([]), 1);
  assert.strictEqual(await command(['--dry-run']), 1);
  assert.deepStrictEqual(options, { notify: false });
  assert.strictEqual(await command(['--unknown']), 2);
  assert.strictEqual(logs.at(-1).error.code, 'INVALID_ARGUMENT');
  const code = await runCommand({ args: [], log: value => logs.push(JSON.parse(value)), monitor: {
    check: async () => { throw new Error('private-api-key'); },
  } });
  assert.strictEqual(code, 2);
  assert.strictEqual(logs.at(-1).error.code, 'MONITOR_FAILED');
  assert(!JSON.stringify(logs).includes('private-api-key'));
}

async function main() {
  await testValidationAndNotifications();
  await testTransport();
  await testCommand();
  console.log('UDトーク設定監視: JSON検証、取得異常、毎回通知・復旧停止、送信失敗、CLIのテストに成功しました。');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
