const assert = require('assert');
const { SendGridMailer, SendGridMailerError } = require('../modules/email/sendgrid_mailer');
const { WordAccountClaimStore } = require('../modules/udtalk/word_account_claim_store');
const { createFixture, validClaim, screenshot } = require('./fixtures/udtalk_claim_fixture');

async function main() {
  process.env.SENDGRID_API_KEY = 'fixture-api-key';
  process.env.SENDGRID_FROM_EMAIL = 'bulk-sender@example.com';
  process.env.MOJIDAS_BROADCAST_FROM_EMAIL = 'different-mojidas-sender@example.com';
  const requests = [];
  const fixture = createFixture({ mailer: new SendGridMailer({ fromName: 'UDトーク', requester: async request => requests.push(request) }) });
  const id = 'a'.repeat(64);
  await Promise.all([fixture.store.submit(id, validClaim, screenshot), fixture.store.submit(id, validClaim, screenshot)]);
  assert.equal(requests.length, 1, '並行申請でも1通');
  const { apiKey, payload } = requests[0];
  assert.equal(apiKey, 'fixture-api-key');
  assert.deepStrictEqual(payload.from, { email: 'bulk-sender@example.com', name: 'UDトーク' });
  assert.deepStrictEqual(payload.personalizations, [{ to: [{ email: validClaim.email }] }]);
  assert(payload.subject.includes('申請を受け付けました'));
  assert.equal(payload.content.length, 1);
  assert.equal(payload.content[0].type, 'text/plain');
  const body = payload.content[0].value;
  assert(body.includes('2〜3日'));
  assert(body.includes('あらかじめご了承'));
  assert(body.includes(validClaim.accountName));
  assert(body.includes(id));
  assert(!body.includes(validClaim.word1), '所有確認に使う単語と画像はメールへ載せない');
  assert(!body.includes('screenshot'));
  assert.equal(fixture.records.get(id).receiptEmail.status, 'sent');
  const restarted = new WordAccountClaimStore({ firestoreProvider: () => fixture.db, bucketProvider: () => fixture.bucket,
    mailer: { send: async () => { throw new Error('送信済みを再送してはいけない'); } } });
  await restarted.submit(id, validClaim, screenshot);
  assert.equal(fixture.records.get(id).receiptEmail.status, 'sent');
  assert.equal(requests.length, 1);

  for (const [error, expectedStatus] of [
    [new SendGridMailerError('SENDGRID_NOT_CONFIGURED', '設定なし'), 'failed'],
    [new SendGridMailerError('SENDGRID_REQUEST_FAILED', '拒否', 403), 'failed'],
    [new SendGridMailerError('SENDGRID_TIMEOUT', 'タイムアウト'), 'unknown'],
    [new SendGridMailerError('SENDGRID_REQUEST_FAILED', 'サーバーエラー', 500), 'unknown'],
  ]) {
    let calls = 0;
    const failed = createFixture({ mailer: { send: async () => { calls += 1; throw error; } } });
    assert.equal(await failed.store.submit(id, validClaim, screenshot), id, 'メール障害でも申請は成功');
    assert.equal(failed.records.get(id).receiptEmail.status, expectedStatus);
    await failed.store.submit(id, validClaim, screenshot);
    assert.equal(calls, 1, '失敗・結果不明を自動再送しない');
    assert.equal(failed.records.size, 1);
  }

  let accepted = 0;
  const unrecorded = createFixture({ mailer: { send: async () => { accepted += 1; unrecorded.db.failUpdate = true; } } });
  await unrecorded.store.submit(id, validClaim, screenshot);
  assert.equal(unrecorded.records.get(id).receiptEmail.status, 'sending');
  await unrecorded.store.submit(id, validClaim, screenshot);
  assert.equal(accepted, 1, '送信後のDB障害でも再送しない');

  const unsaved = createFixture();
  unsaved.db.fail = true;
  await assert.rejects(unsaved.store.submit(id, validClaim, screenshot));
  assert.equal(unsaved.deliveries.length, 0, '申請保存前は送信しない');
  await unsaved.store.submit(id, validClaim, screenshot);
  assert.equal(unsaved.deliveries.length, 1);
  const legacy = { ...unsaved.records.get(id) };
  delete legacy.receiptEmail;
  unsaved.records.set(id, legacy);
  await unsaved.store.submit(id, validClaim, screenshot);
  assert.equal(unsaved.deliveries.length, 1, '導入前の申請へ遡及送信しない');

  const pending = createFixture();
  pending.records.set(id, { ...legacy, receiptEmail: { status: 'pending' } });
  await pending.store.submit(id, validClaim, screenshot);
  assert.equal(pending.deliveries.length, 1, '送信開始前の中断は再送で回復');
  assert.equal(pending.records.get(id).receiptEmail.status, 'sent');
  console.log('UDTalk受付メール: 宛先・共通送り元・本文・並行再送・再起動・送信障害・保存障害・過去申請の保全を確認しました。');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
