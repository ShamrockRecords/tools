const assert = require('assert');
const express = require('express');
const { createUdtalkMonitorRouter } = require('../routes/api/udtalk_monitor');
const { ServicePropertiesError } = require('../modules/monitoring/udtalk_service_properties');
const { request, listen } = require('./partner_http_helper');

async function main() {
  let calls = 0;
  let result = { ok: true, notification: 'not_needed' };
  let failure;
  const monitor = { check: async (...args) => {
    calls++;
    assert.deepStrictEqual(args, []);
    if (failure) throw failure;
    return result;
  } };
  const app = express();
  app.use('/api/udtalk', createUdtalkMonitorRouter({ token: 'test-token', monitor }));
  app.use('/disabled', createUdtalkMonitorRouter({ token: '', monitor }));
  const server = await listen(app);
  const path = '/api/udtalk/service-properties/check';
  const send = (options = {}) => request(server, path, { method: 'POST', token: 'test-token', ...options });
  try {
    for (const header of ['', 'Basic test-token', 'Bearer wrong', 'Bearer test-token extra']) {
      assert.strictEqual((await send({ headers: { Authorization: header } })).status, 401);
    }
    assert.strictEqual(calls, 0);
    assert.strictEqual((await request(server, '/disabled/service-properties/check', { method: 'POST' })).status, 503);
    assert.strictEqual((await send({ method: 'GET' })).status, 404);
    assert.strictEqual(calls, 0);
    let response = await send({ body: { notify: false, url: 'https://example.com', to: 'other@example.com' } });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers['cache-control'], 'no-store');
    assert.deepStrictEqual(response.body, result);
    assert.strictEqual(calls, 1);
    result = { ok: false, error: { code: 'INVALID_JSON' }, notification: 'accepted' };
    response = await send();
    assert.strictEqual(response.status, 502);
    assert.deepStrictEqual(response.body, result);
    failure = new ServicePropertiesError('MONITOR_NOT_CONFIGURED', '設定不足');
    assert.strictEqual((await send()).status, 503);
    failure = new ServicePropertiesError('ALERT_EMAIL_FAILED', '通知失敗', { ...result, notification: 'failed' });
    response = await send();
    assert.strictEqual(response.status, 502);
    assert.strictEqual(response.body.result.notification, 'failed');
    failure = new Error('private-api-key');
    response = await send();
    assert.strictEqual(response.status, 500);
    assert(!response.text.includes('private-api-key'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('UDトーク監視API: 認証、設定不足、正常・異常、通知失敗のテストに成功しました。');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
