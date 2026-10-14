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
  delete legacy.adminNotificationEmail;
  unsaved.records.set(id, legacy);
  await unsaved.store.submit(id, validClaim, screenshot);
  assert.equal(unsaved.deliveries.length, 1, '導入前の申請へ遡及送信しない');

  const pending = createFixture();
  pending.records.set(id, { ...legacy, receiptEmail: { status: 'pending' } });
  await pending.store.submit(id, validClaim, screenshot);
  assert.equal(pending.deliveries.length, 1, '送信開始前の中断は再送で回復');
  assert.equal(pending.records.get(id).receiptEmail.status, 'sent');
  const adminRequests = [];
  process.env.ADMIN_EMAIL = 'admin@example.com';
  process.env.ROOT_URL = 'https://support.example.com/';
  const notified = createFixture({ adminEmail: process.env.ADMIN_EMAIL,
    mailer: new SendGridMailer({ requester: async request => adminRequests.push(request) }) });
  await Promise.all([notified.store.submit(id, validClaim, screenshot), notified.store.submit(id, validClaim, screenshot)]);
  assert.equal(adminRequests.length, 2, '申請者と管理者にそれぞれ1通');
  const adminPayload = adminRequests.find(request => request.payload.categories.includes('udtalk-word-account-claim-admin')).payload;
  assert.deepStrictEqual(adminPayload.personalizations, [{ to: [{ email: 'admin@example.com' }] }]);
  const adminBody = adminPayload.content[0].value;
  for (const value of [validClaim.accountName, validClaim.email, id, 'https://support.example.com/admin/udtalk-word-account-claims']) assert(adminBody.includes(value));
  assert(!adminBody.includes(validClaim.word1));
  assert.equal(notified.records.get(id).adminNotificationEmail.status, 'sent');
  const adminRestarted = new WordAccountClaimStore({ firestoreProvider: () => notified.db, bucketProvider: () => notified.bucket,
    mailer: { send: async () => { throw new Error('再送不可'); } } });
  await adminRestarted.submit(id, validClaim, screenshot);
  assert.equal(adminRequests.length, 2, '再起動・再送でも通知は重複しない');

  for (const failAdmin of [false, true]) {
    const calls = [];
    const independent = createFixture({ adminEmail: process.env.ADMIN_EMAIL, mailer: { send: async message => {
      calls.push(message.to);
      if ((message.to === process.env.ADMIN_EMAIL) === failAdmin) throw new SendGridMailerError('SENDGRID_REQUEST_FAILED', '拒否', 403);
    } } });
    await independent.store.submit(id, validClaim, screenshot);
    assert.equal(independent.records.get(id).receiptEmail.status, failAdmin ? 'sent' : 'failed');
    assert.equal(independent.records.get(id).adminNotificationEmail.status, failAdmin ? 'failed' : 'sent');
    await independent.store.submit(id, validClaim, screenshot);
    assert.equal(calls.length, 2, '片方の失敗で他方の送信や申請を妨げず重複送信もしない');
  }
  const past = createFixture({ adminEmail: process.env.ADMIN_EMAIL });
  past.records.set(id, legacy);
  await past.store.submit(id, validClaim, screenshot);
  assert.equal(past.deliveries.length, 0, '既存申請へ管理者通知を遡及しない');
  const notSavedAdmin = createFixture({ adminEmail: process.env.ADMIN_EMAIL });
  notSavedAdmin.db.fail = true;
  await assert.rejects(notSavedAdmin.store.submit(id, validClaim, screenshot));
  assert.equal(notSavedAdmin.deliveries.length, 0, '保存失敗時は管理者にも送信しない');
  const recovery = createFixture();
  await recovery.store.submit(id, validClaim, screenshot);
  recovery.deliveries.length = 0;
  let releaseRecovery;
  let recoveryStarted;
  const started = new Promise(resolve => { recoveryStarted = resolve; });
  const release = new Promise(resolve => { releaseRecovery = resolve; });
  recovery.store.mailer = { send: async message => { recovery.deliveries.push(message); recoveryStarted(); await release; } };
  const firstRecovery = recovery.store.sendRecovery(id);
  await started;
  await assert.rejects(recovery.store.sendRecovery(id), /recoveryBusy/);
  releaseRecovery();
  await firstRecovery;
  assert.equal(recovery.deliveries.length, 1, '並行クリックでも1通');
  const recoveryMessage = recovery.deliveries[0];
  assert.equal(recoveryMessage.to, validClaim.email);
  assert.equal(recoveryMessage.subject, '【UDトーク】単語登録アカウントの復旧が完了しました');
  assert(recoveryMessage.text.includes('「パスワードを忘れてしまった方は」'));
  for (const value of [validClaim.accountName, validClaim.word1, validClaim.email, id, 'https://']) assert(!recoveryMessage.text.includes(value));
  assert.equal(recovery.records.get(id).recoveryEmail.status, 'sent');
  await recovery.store.sendRecovery(id);
  assert.equal(recovery.deliveries.length, 2, '明示的な再送は送れる');
  const recoveryFailed = createFixture({ mailer: { send: async () => { throw new SendGridMailerError('SENDGRID_REQUEST_FAILED', '拒否', 403); } } });
  recoveryFailed.records.set(id, { ...legacy });
  await assert.rejects(recoveryFailed.store.sendRecovery(id), /recoverySend/);
  assert.equal(recoveryFailed.records.get(id).recoveryEmail.status, 'failed');
  await assert.rejects(recovery.store.sendRecovery('invalid'), /notFound/);
  console.log('UDTalk受付メール: 宛先・共通送り元・本文・並行再送・再起動・送信障害・保存障害・過去申請の保全を確認しました。');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
