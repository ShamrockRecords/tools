const assert = require('assert');
const { MojidasBroadcastService } = require('../modules/email/mojidas_broadcast_service');
const { MojidasAccountDeletionService } = require('../modules/auth/mojidas_account_deletion');
const { TransactionalFirestore } = require('./mojidas_credit_integrity.test');

function fixture(count, requester) {
  let now = Date.parse('2026-09-11T00:00:00Z');
  const db = new TransactionalFirestore();
  const accounts = new Map(Array.from({ length: count }, (_, i) => [`u${i}`, { uid: `u${i}`, email: `user${i}@example.invalid` }]));
  const pages = [];
  const auth = {
    async listUsers(limit, token) {
      pages.push({ limit, token });
      const rows = [...accounts.values()];
      const start = Number(token || 0);
      return { users: rows.slice(start, start + limit), pageToken: start + limit < rows.length ? String(start + limit) : undefined };
    },
    async getUsers(ids) {
      assert(ids.length <= 100);
      return { users: ids.map(item => accounts.get(item.uid)).filter(Boolean) };
    },
  };
  const deletionService = new MojidasAccountDeletionService({ firestoreProvider: () => db,
    authProvider: () => auth, environment: { MOJIDAS_ACCOUNT_DELETION_SECRET: 'isolated-broadcast-test-secret-32-characters' } });
  const deleted = email => deletionService.collection('deletedAccountEmails').doc(deletionService.emailDigest(email)).set({ deletedAt: new Date(now) });
  const calls = [];
  const service = new MojidasBroadcastService({ firestoreProvider: () => db, authProvider: () => auth,
    deletionService, now: () => now, configuration: () => ({ apiKey: 'fixture-no-network', fromEmail: 'sender@example.invalid' }),
    requester: async request => { calls.push(request); if (requester) await requester(request, calls.length); },
  });
  return { db, accounts, auth, pages, deleted, service, calls, advance: ms => { now += ms; } };
}
const draft = { subject: 'Mojidasのお知らせ', body: 'こんにちは。\n\nテキスト本文です。<b>これは文字列</b>', adminEmail: 'admin@example.invalid' };
async function settle(service) { await Promise.all([...service.tasks.values()]); }
async function main() {
  let f;
  f = fixture(1503, async (_request, number) => {
    if (number === 1) {
      await f.deleted('user1200@example.invalid');
      f.accounts.get('u1250').email = 'changed@example.invalid';
    }
  });
  f.accounts.set('duplicate', { uid: 'duplicate', email: 'USER0@example.invalid' });
  f.accounts.set('missing', { uid: 'missing' });
  f.accounts.set('deleted-in-progress', { uid: 'deleted-in-progress', email: 'deleted@example.invalid' });
  await f.deleted('deleted@example.invalid');
  const job = await f.service.prepare(draft);
  assert.equal(f.calls.length, 0, '確認画面だけでは送信しない');
  assert.equal(f.pages.length, 2);
  assert.equal(job.recipientCount, 1503, '従来の1500件上限を超えて全ページ取得する');
  assert.equal(job.duplicateCount, 1);
  assert.equal(job.skippedCount, 2);
  f.accounts.delete('u1100');
  await Promise.all([f.service.start(job.id, draft.adminEmail), f.service.start(job.id, draft.adminEmail)]);
  await settle(f.service);
  const result = await f.service.get(job.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.acceptedCount, 1500);
  assert.equal(result.excludedCount, 3);
  assert.equal(f.calls.length, 4);
  const emails = f.calls.flatMap(call => call.payload.personalizations.map(item => {
    assert.deepStrictEqual(Object.keys(item), ['to']);
    assert.equal(item.to.length, 1, '各受信者へ他の宛先を公開しない');
    return item.to[0].email;
  }));
  assert.equal(new Set(emails.map(email => email.toLowerCase())).size, 1500);
  for (const email of ['user1100@example.invalid', 'user1200@example.invalid', 'user1250@example.invalid', 'deleted@example.invalid']) assert(!emails.includes(email));
  for (const call of f.calls) {
    assert(call.payload.personalizations.length <= 500);
    assert.equal(call.payload.subject, draft.subject);
    assert.deepStrictEqual(call.payload.content, [{ type: 'text/plain', value: draft.body }]);
  }
  await f.service.start(job.id, draft.adminEmail);
  await settle(f.service);
  assert.equal(f.calls.length, 4, '完了後も再送しない');

  const failed = fixture(501, async (_request, number) => { if (number === 2) throw new Error('uncertain timeout'); });
  const failureJob = await failed.service.prepare(draft);
  await failed.service.start(failureJob.id, draft.adminEmail); await settle(failed.service);
  const partial = await failed.service.get(failureJob.id);
  assert.equal(partial.status, 'attention'); assert.equal(partial.acceptedCount, 500); assert.equal(partial.uncertainCount, 1);
  await failed.service.start(failureJob.id, draft.adminEmail); await settle(failed.service);
  assert.equal(failed.calls.length, 2, '結果不明のバッチを自動再送しない');

  for (const statusCode of [429, 503]) {
    const rejected = fixture(1, async () => { throw Object.assign(new Error('provider error'), { statusCode }); });
    const rejectedJob = await rejected.service.prepare(draft);
    await rejected.service.start(rejectedJob.id, draft.adminEmail); await settle(rejected.service);
    const outcome = await rejected.service.get(rejectedJob.id);
    assert.equal(outcome.acceptedCount, 0);
    assert.equal(outcome.rejectedCount, statusCode === 429 ? 1 : 0);
    assert.equal(outcome.uncertainCount, statusCode === 503 ? 1 : 0);
  }
  const unconfigured = fixture(1);
  const unconfiguredJob = await unconfigured.service.prepare(draft);
  unconfigured.service.configuration = () => ({});
  await assert.rejects(() => unconfigured.service.start(unconfiguredJob.id, draft.adminEmail), e => e.code === 'SENDGRID_NOT_CONFIGURED');
  assert.equal((await unconfigured.service.get(unconfiguredJob.id)).status, 'draft');
  assert.equal(unconfigured.calls.length, 0);

  const removed = fixture(1);
  const removalJob = await removed.service.prepare(draft);
  removed.accounts.clear();
  await removed.service.start(removalJob.id, draft.adminEmail); await settle(removed.service);
  assert.equal(removed.calls.length, 0);
  assert.equal((await removed.service.get(removalJob.id)).excludedCount, 1);

  const unavailable = fixture(1);
  const unavailableJob = await unavailable.service.prepare(draft);
  unavailable.auth.getUsers = async () => { throw new Error('auth unavailable'); };
  await unavailable.service.start(unavailableJob.id, draft.adminEmail); await settle(unavailable.service);
  assert.equal(unavailable.calls.length, 0, '削除状態を検証できなければ送らない');
  assert.equal((await unavailable.service.get(unavailableJob.id)).status, 'attention');

  const expired = fixture(1);
  const expiredJob = await expired.service.prepare(draft);
  expired.advance(31 * 60 * 1000);
  await assert.rejects(() => expired.service.start(expiredJob.id, draft.adminEmail), e => e.code === 'BROADCAST_EXPIRED');
  assert.equal((await expired.service.get(expiredJob.id)).status, 'expired');
  assert.equal(expired.calls.length, 0);
  const broken = fixture(1);
  broken.auth.listUsers = async () => { throw new Error('list failed'); };
  await assert.rejects(() => broken.service.prepare(draft));
  assert.equal(broken.db.records('Mojidas/production/mailBroadcasts')[0].data.status, 'preparation_failed');
  assert.equal(broken.calls.length, 0);
  for (const change of [{ subject: '' }, { subject: 'header\ninjection' }, { body: '' }, { body: 'a'.repeat(50001) }]) {
    await assert.rejects(() => broken.service.prepare({ ...draft, ...change }), e => e.code === 'INVALID_BROADCAST');
  }
  // 再起動で失われた実行処理を勝手に再送しない。
  const stale = fixture(1);
  const staleJob = await stale.service.prepare(draft);
  await stale.service.document(staleJob.id).update({ status: 'sending' });
  stale.advance(6 * 60 * 1000);
  assert.equal((await stale.service.get(staleJob.id)).status, 'attention');
  await stale.service.start(staleJob.id, draft.adminEmail);
  assert.equal(stale.calls.length, 0);
  console.log('Mojidas一斉メール: 全ページ・削除済み/削除途中/送信前削除の除外・宛先非公開・二重送信・途中失敗・期限切れを検証（外部送信なし）');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
