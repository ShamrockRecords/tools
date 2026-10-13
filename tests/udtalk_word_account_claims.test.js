const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { normalizeClaim, validateScreenshot, ClaimError, MAX_IMAGE_BYTES } = require('../modules/udtalk/word_account_claim_store');
const { udtalkRootPath } = require('../modules/udtalk_firestore');
const { createFixture, validClaim, screenshot } = require('./fixtures/udtalk_claim_fixture');

const id = () => crypto.randomBytes(32).toString('hex');
const FORM = '/udtalk/word-account-claim';
const ADMIN = '/admin/udtalk-word-account-claims';

function request(server, path, { method = 'GET', data, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method,
      headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Length': data.length } : {}) },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes, text: bytes.toString(),
          cookie: res.headers['set-cookie']?.find(value => value.startsWith('connect.sid='))?.split(';')[0] });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function multipart(body, file = screenshot, extraFile = false) {
  const boundary = `test-${crypto.randomBytes(8).toString('hex')}`;
  const parts = [];
  for (const [key, value] of Object.entries(body)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  for (let i = 0; i < (file ? (extraFile ? 2 : 1) : 0); i += 1) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="screenshot"; filename="capture.png"\r\nContent-Type: ${file.mimetype}\r\n\r\n`), file.buffer, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, data: Buffer.concat(parts) };
}

function formFields(response) {
  return { ...validClaim,
    requestID: response.text.match(/name="requestID" value="([^"]+)"/)[1],
    formToken: response.text.match(/name="formToken" value="([^"]+)"/)[1],
  };
}

async function main() {
  assert.equal(udtalkRootPath(), 'UDTalk/production');
  process.env.UDTALK_FIRESTORE_ENV = '../wrong';
  assert.throws(udtalkRootPath);
  process.env.UDTALK_FIRESTORE_ENV = 'test';
  assert.equal(udtalkRootPath(), 'UDTalk/test');
  delete process.env.UDTALK_FIRESTORE_ENV;

  for (const field of Object.keys(validClaim)) {
    for (const value of ['', '  ', ['unexpected'], null, 'x'.repeat(255)]) {
      assert.throws(() => normalizeClaim({ ...validClaim, [field]: value }), ClaimError);
    }
  }
  assert.throws(() => normalizeClaim({ ...validClaim, emailConfirmation: 'wrong@example.com' }), /emailMismatch/);
  assert.throws(() => normalizeClaim({ ...validClaim, word2: validClaim.word1, reading2: validClaim.reading1 }), /duplicateWords/);
  assert.equal(normalizeClaim({ ...validClaim, accountName: ' 名前 ' }).accountName, '名前');
  assert(!('emailConfirmation' in normalizeClaim(validClaim)));
  assert.equal(validateScreenshot(screenshot).contentType, 'image/png');
  for (const file of [undefined, { ...screenshot, buffer: Buffer.alloc(0) }, { ...screenshot, mimetype: 'image/jpeg' },
    { ...screenshot, buffer: Buffer.from('<svg onload="alert(1)"></svg>') }, { ...screenshot, buffer: Buffer.alloc(MAX_IMAGE_BYTES + 1) }]) {
    assert.throws(() => validateScreenshot(file), ClaimError);
  }

  const fixture = createFixture();
  const firstID = id();
  await Promise.all([fixture.store.submit(firstID, validClaim, screenshot), fixture.store.submit(firstID, validClaim, screenshot)]);
  assert.equal(fixture.records.size, 1);
  assert.equal(fixture.objects.size, 1);
  await fixture.store.submit(firstID, validClaim, screenshot);
  await assert.rejects(fixture.store.submit(firstID, { ...validClaim, accountName: '別の名前' }, screenshot), /alreadySubmitted/);
  assert.equal(fixture.records.get(firstID).accountName, validClaim.accountName);
  assert.deepStrictEqual((await fixture.store.screenshot(firstID)).buffer, screenshot.buffer);
  await assert.rejects(fixture.store.screenshot('../secret'), /notFound/);
  await assert.rejects(fixture.store.screenshot(id()), /notFound/);
  const recoverID = id();
  fixture.db.fail = true;
  await assert.rejects(fixture.store.submit(recoverID, validClaim, screenshot), /保存失敗/);
  assert(!fixture.records.has(recoverID));
  await fixture.store.submit(recoverID, validClaim, screenshot);
  assert(fixture.records.has(recoverID));
  fixture.bucket.fail = true;
  await assert.rejects(fixture.store.submit(id(), validClaim, screenshot), /画像保存失敗/);
  assert.equal(fixture.records.size, 2);
  fixture.bucket.fail = false;
  for (let i = 0; i < 23; i += 1) await fixture.store.submit(id(), validClaim, screenshot);
  const first = await fixture.store.list();
  const second = await fixture.store.list(first.next);
  assert.equal(first.rows.length, 20);
  assert.equal(second.rows.length, 5);
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row.id)).size, 25);
  assert.equal(second.next, null);
  await assert.rejects(fixture.store.list('../escape'), /page/);
  await assert.rejects(fixture.store.list(id()), /page/);

  process.env.NODE_ENV = 'test';
  process.env.ROOT_URL = 'http://localhost:3000';
  process.env.SESSION_SECRET = 'udtalk-claim-fixture-only';
  process.env.FIREBASE_ADMIN_CREDENTIALS = '';
  process.env.ADMIN_EMAIL = 'admin@example.com';
  process.env.ADMIN_PASSWORD_HASH = require('../modules/auth/admin_credentials').createAdminPasswordHash('fixture-password-1234');
  const app = require('../app');
  const httpFixture = createFixture();
  app.locals.udtalkWordAccountClaimStore = httpFixture.store;
  const server = await new Promise(resolve => { const active = app.listen(0, '127.0.0.1', () => resolve(active)); });
  try {
    assert.equal((await request(server, ADMIN)).status, 302);
    assert.equal((await request(server, `${ADMIN}/${id()}/screenshot`)).status, 302);
    assert.equal((await request(server, `${FORM}/complete`)).status, 302);
    const form = await request(server, FORM);
    assert.equal(form.status, 200);
    assert(form.text.includes('<h1>単語登録アカウント所持申請</h1>'));
    assert.equal((form.text.match(/ required>/g) || []).length, 10);
    assert.equal((await request(server, `${FORM}?lang=en`)).status, 200);
    const body = formFields(form);
    const send = (payload, file, cookie = form.cookie, extra = false) => request(server, FORM, { ...multipart(payload, file, extra), cookie });
    assert.equal((await send(body, screenshot, 'connect.sid=invalid')).status, 403);
    assert.equal((await send({ ...body, formToken: '0'.repeat(64) }, screenshot)).status, 403);
    const invalid = await send({ ...body, emailConfirmation: 'mismatch@example.com' }, screenshot);
    assert.equal(invalid.status, 400);
    assert(invalid.text.includes('メールアドレスが一致'));
    assert(invalid.text.includes('value="テストアカウント"'));
    assert.equal((await send(body, null)).status, 400);
    assert.equal((await send(body, { ...screenshot, buffer: Buffer.from('<html>偽装画像</html>') })).status, 400);
    assert.equal((await send(body, { ...screenshot, buffer: Buffer.alloc(MAX_IMAGE_BYTES + 1) })).status, 413);
    assert.equal((await send(body, screenshot, form.cookie, true)).status, 400);
    assert.equal(httpFixture.records.size, 0);
    const xssBody = { ...body, accountName: '<script>alert(1)</script>' };
    const submitted = await send(xssBody, screenshot);
    assert.equal(submitted.status, 303);
    assert.equal(submitted.headers.location, `${FORM}/complete`);
    assert.equal((await send(xssBody, screenshot)).status, 303);
    assert.equal(httpFixture.records.size, 1);
    const complete = await request(server, `${FORM}/complete`, { cookie: submitted.cookie || form.cookie });
    assert(complete.text.includes('申請を受け付けました'));
    assert(complete.text.includes(body.formToken));
    assert.equal((await send(body, screenshot)).status, 409);
    const limited = await send(body, screenshot);
    assert.equal(limited.status, 429);
    assert(limited.headers['retry-after']);
    const login = await request(server, '/admin/login', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: Buffer.from(new URLSearchParams({ email: process.env.ADMIN_EMAIL, password: 'fixture-password-1234' }).toString()),
    });
    assert.equal(login.status, 302);
    const dashboard = await request(server, '/admin', { cookie: login.cookie });
    assert(dashboard.text.includes(ADMIN));
    const list = await request(server, ADMIN, { cookie: login.cookie });
    assert.equal(list.status, 200);
    assert(!list.text.includes('<script>alert(1)</script>'));
    assert(list.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert(list.text.includes('とうきょう'));
    assert(list.text.includes('owner@example.com'));
    assert(list.headers['cache-control'].includes('no-store'));
    const image = await request(server, `${ADMIN}/${body.formToken}/screenshot`, { cookie: login.cookie });
    assert.equal(image.status, 200);
    assert.equal(image.headers['content-type'], 'image/png');
    assert.equal(image.headers['x-content-type-options'], 'nosniff');
    assert.deepStrictEqual(image.bytes, screenshot.buffer);
    assert.equal((await request(server, `${ADMIN}/unknown/screenshot`, { cookie: login.cookie })).status, 404);
    assert.equal((await request(server, `${ADMIN}?after=invalid`, { cookie: login.cookie })).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('UDTalk単語登録アカウント所持申請の検証に成功しました。');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
