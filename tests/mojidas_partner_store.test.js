const assert = require('assert');
const { FakeFirestore } = require('./mojidas_credit_store.test');
const { PartnerStore } = require('../modules/partners/partner_store');
const { normalizeDomain, isSharedDomain } = require('../modules/partners/domain_policy');

async function main() {
  const db = new FakeFirestore();
  let clock = Date.UTC(2026, 8, 15), sent;
  const store = new PartnerStore({ firestoreProvider: () => db, now: () => clock,
    mailer: { send: async message => { sent = message; } } });
  assert.equal(normalizeDomain(' EXAMPLE.CO.JP '), 'example.co.jp');
  for (const value of ['https://example.com', 'name@example.com', '*.example.com', 'localhost', '127.0.0.1'])
    assert.equal(normalizeDomain(value), null);
  assert(isSharedDomain('gmail.com'));
  assert(isSharedDomain('mail.gmail.com'));
  assert(!isSharedDomain('example.co.jp'));
  const id = await store.invite('partner@example.net', '販売店');
  const token = sent.text.match(/token=([a-f0-9]{64})/)[1];
  assert.equal(await store.activePartner(id), null);
  await assert.rejects(store.accept(id, '0'.repeat(64), 'test-password'), { code: 'INVALID_INVITE' });
  await store.accept(id, token, 'test-password');
  await assert.rejects(store.accept(id, token, 'new-password'), { code: 'INVALID_INVITE' });
  await assert.rejects(store.login('partner@example.net', 'wrong-password'), { code: 'LOGIN_FAILED' });
  assert.equal(await store.login('partner@example.net', 'test-password'), id);
  await assert.rejects(store.invite('partner@example.net', '別の名前'), { code: 'PARTNER_EXISTS' });
  assert.equal((await store.activePartner(id)).name, '販売店');
  const input = { domain: 'example.co.jp', organizationName: '組織', website: 'https://example.co.jp', contact: '担当者' };
  await assert.rejects(store.submit(id, { ...input, domain: 'gmail.com' }), { code: 'INVALID_DOMAIN' });
  await store.submit(id, input);
  await assert.rejects(store.submit(id, input), { code: 'DOMAIN_EXISTS' });
  const user = { email: 'member@example.co.jp', emailVerified: true };
  assert.equal(await store.entitlement(user), null);
  await store.review(input.domain, 'approved', 'admin@example.org');
  assert.equal((await store.entitlement(user)).partnerID, id);
  assert.equal(await store.entitlement({ ...user, emailVerified: false }), null);
  assert.equal(await store.entitlement({ ...user, disabled: true }), null);
  assert.equal(await store.entitlement({ ...user, email: 'member@sub.example.co.jp' }), null);
  assert.equal(await store.entitlement({ ...user, email: 'member@other.co.jp' }), null);
  await store.review(input.domain, 'suspended', 'admin@example.org');
  assert.equal(await store.entitlement(user), null);
  await store.review(input.domain, 'approved', 'admin@example.org');
  assert.equal((await store.entitlement(user)).domain, input.domain);
  await store.collection('corporateUsageMonths').doc(`${id}_${input.domain}_2026-09`).set({ realtime: 6000 });
  await store.collection('corporateUsageMonths').doc(`${id}_${input.domain}_2026-08`).set({ realtime: 99000 });
  await store.collection('corporateDomains').doc('other.example').set({ partnerID: 'other' });
  const dashboard = await store.dashboard(id, '2026-09');
  assert.equal(dashboard.length, 1);
  assert.deepEqual(dashboard[0].usage, { realtime: 6000, mediaFile: 0, formalTranslation: 0 });
  const expiredID = await store.invite('expired@example.net', '期限切れ');
  const expiredToken = sent.text.match(/token=([a-f0-9]{64})/)[1];
  clock += 24 * 60 * 60 * 1000;
  await assert.rejects(store.accept(expiredID, expiredToken, 'test-password'), { code: 'INVALID_INVITE' });
  assert.equal(await store.activePartner(expiredID), null);
  console.log('販売店ストア: ドメイン・招待・承認・解除の隔離テスト成功（本番通信なし）');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
