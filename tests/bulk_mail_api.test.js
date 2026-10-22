const assert = require('assert');
const http = require('http');
const https = require('https');
const { EventEmitter, once } = require('events');
const express = require('express');

process.env.NODE_ENV = 'test';

function request(server, body, authenticated = true) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ csrfToken: 'fixture-csrf', ...body });
    const req = http.request({
      host: '127.0.0.1', port: server.address().port,
      method: 'POST', path: '/admin/bulk-mail', agent: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(authenticated ? { 'X-Test-Admin': '1' } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function main() {
  const originalRequest = https.request;
  const originalConfig = [process.env.SENDGRID_API_KEY, process.env.SENDGRID_FROM_EMAIL];
  const calls = [];
  const sender = 'info@example.invalid';
  const message = { subject: '一斉メールの確認', body: '本文の1行目\n本文の2行目' };
  let server;

  // HTTPS通信はすべて置き換え、実際のSendGridや他の外部サービスへは接続しない。
  https.request = (options, callback) => {
    assert.equal(options.hostname, 'api.sendgrid.com');
    assert.equal(options.path, '/v3/mail/send');
    assert.equal(options.headers.Authorization, 'Bearer fixture-key-no-network');
    let payload = '';
    const req = new EventEmitter();
    req.write = (chunk) => { payload += chunk; };
    req.end = () => {
      calls.push(JSON.parse(payload));
      const res = new EventEmitter();
      res.statusCode = 202;
      callback(res);
      process.nextTick(() => res.emit('end'));
    };
    return req;
  };

  try {
    process.env.SENDGRID_API_KEY = 'fixture-key-no-network';
    process.env.SENDGRID_FROM_EMAIL = ' ' + sender + ' ';
    const app = express();
    app.use(express.json());
    // 管理者セッションだけを用意し、実DBや実際のログイン資格情報を使わない。
    app.use((req, res, next) => {
      req.session = req.headers['x-test-admin'] === '1'
        ? { adminUser: { email: 'admin@example.invalid' }, adminCSRFToken: 'fixture-csrf' } : {};
      next();
    });
    app.use('/admin', require('../routes/admin'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const deliveredEmails = () => calls.flatMap((call) => call.personalizations.map((item) => item.to[0].email));
    function checkContent() {
      for (const call of calls) {
        assert.deepStrictEqual(call.from, { email: process.env.SENDGRID_FROM_EMAIL.trim() });
        assert.equal(call.subject, message.subject);
        assert.deepStrictEqual(call.content, [{ type: 'text/plain', value: message.body }]);
        assert.ok(call.personalizations.length <= 500, '500件を超えるバッチを送らない');
        assert.equal(call.cc, undefined);
        assert.equal(call.bcc, undefined);
        for (const item of call.personalizations) {
          assert.deepStrictEqual(Object.keys(item), ['to'], '他の宛先をCC/BCCに含めない');
          assert.equal(item.to.length, 1, '宛先ごとに独立したメールにする');
        }
      }
    }

    let response = await request(server, { ...message, recipients: 'reader@example.invalid', csrfToken: '' });
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);
    response = await request(server, { ...message, recipients: 'reader@example.invalid', csrfToken: 'invalid' });
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);
    response = await request(server, { ...message, recipients: 'reader@example.invalid' });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).success, true);
    assert.deepStrictEqual(deliveredEmails(), ['reader@example.invalid', sender]);
    checkContent();

    for (const recipients of [
      sender,
      'reader@example.invalid\n' + sender + '\n' + sender,
      sender.toUpperCase() + '\nreader@example.invalid\n' + sender,
    ]) {
      calls.length = 0;
      response = await request(server, { ...message, recipients });
      assert.equal(response.status, 200);
      assert.equal(deliveredEmails().filter((email) => email.toLowerCase() === sender).length, 1,
        '送信元が入力済みでも、大文字小文字の違いを含めて1通だけにする');
      checkContent();
    }

    calls.length = 0;
    const recipients = Array.from({ length: 1500 }, (_, index) => 'reader' + index + '@example.invalid');
    response = await request(server, { ...message, recipients: recipients.join('\n') });
    assert.equal(response.status, 200, '入力宛先の上限1500件は維持する');
    assert.deepStrictEqual(calls.map((call) => call.personalizations.length), [500, 500, 500, 1]);
    assert.deepStrictEqual(deliveredEmails(), [...recipients, sender], '複数バッチでも控えは全体で1通だけ');
    checkContent();

    calls.length = 0;
    process.env.SENDGRID_FROM_EMAIL = 'changed@example.invalid';
    response = await request(server, { ...message, recipients: 'reader@example.invalid' });
    assert.equal(response.status, 200);
    assert.deepStrictEqual(deliveredEmails(), ['reader@example.invalid', 'changed@example.invalid'],
      '控えの送信先は固定値ではなく現在のFrom設定に従う');
    checkContent();

    calls.length = 0;
    for (const recipientsText of ['', 'invalid-address', [...recipients, 'extra@example.invalid'].join('\n')]) {
      response = await request(server, { ...message, recipients: recipientsText });
      assert.equal(response.status, 400);
    }
    response = await request(server, { ...message, recipients: sender }, false);
    assert.equal(response.status, 302);
    assert.equal(calls.length, 0, '無効な要求や未ログインでは控えも送信しない');

    console.log('通常の一斉メール: Fromへの控え1通・重複除外・1500件の分割送信・宛先非公開・入力検証を確認（外部送信なし）');
  } finally {
    https.request = originalRequest;
    ['SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL'].forEach((key, index) => {
      if (originalConfig[index] === undefined) delete process.env[key];
      else process.env[key] = originalConfig[index];
    });
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
