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
  await assert.rejects(store.addDomain(id, { domain: 'invited.example', organizationName: '招待中' }, 'admin@example.org'),
    { code: 'FORBIDDEN' });
  await assert.rejects(store.accept(id, '0'.repeat(64), 'test-password'), { code: 'INVALID_INVITE' });
  await store.accept(id, token, 'test-password');
  await assert.rejects(store.accept(id, token, 'new-password'), { code: 'INVALID_INVITE' });
  await assert.rejects(store.login('partner@example.net', 'wrong-password'), { code: 'LOGIN_FAILED' });
  assert.equal(await store.login('partner@example.net', 'test-password'), id);
  await assert.rejects(store.invite('partner@example.net', '別の名前'), { code: 'PARTNER_EXISTS' });
  assert.equal((await store.activePartner(id)).name, '販売店');
  const beforeEdit = (await store.collection('partners').doc(id).get()).data();
  await store.updateName(id, ' 新しい販売店名 ');
  await store.updateName(id, ' 新しい販売店名 ');
  assert.deepEqual((await store.collection('partners').doc(id).get()).data(), { ...beforeEdit, name: '新しい販売店名' });
  for (const name of ['', ' ', 'a'.repeat(121), null]) await assert.rejects(store.updateName(id, name));
  await assert.rejects(store.updateName('0'.repeat(64), '存在しない販売店'));
  assert.equal(await store.login('partner@example.net', 'test-password'), id);
  const input = { domain: 'example.co.jp', organizationName: '組織' };
  await assert.rejects(store.addDomain(id, { ...input, domain: 'gmail.com' }), { code: 'INVALID_DOMAIN' });
  await store.addDomain(id, input, 'admin@example.org');
  await assert.rejects(store.addDomain(id, input), { code: 'DOMAIN_EXISTS' });
  const user = { email: 'member@example.co.jp', emailVerified: true };
  assert.equal((await store.entitlement(user)).partnerID, id, '追加直後から有効');
  await store.setDomainStatus(input.domain, 'active', 'admin@example.org');
  assert.equal((await store.entitlement(user)).partnerID, id);
  assert.equal(await store.entitlement({ ...user, emailVerified: false }), null);
  assert.equal(await store.entitlement({ ...user, disabled: true }), null);
  assert.equal(await store.entitlement({ ...user, email: 'member@sub.example.co.jp' }), null);
  assert.equal(await store.entitlement({ ...user, email: 'member@other.co.jp' }), null);
  await store.setDomainStatus(input.domain, 'inactive', 'admin@example.org');
  assert.equal(await store.entitlement(user), null);
  await store.setDomainStatus(input.domain, 'active', 'admin@example.org');
  assert.equal((await store.entitlement(user)).domain, input.domain);
  const beforeDomain = (await store.collection('corporateDomains').doc(input.domain).get()).data();
  const beforeFailedAdd = JSON.stringify([...db.collections].map(([name, values]) => [name, [...values]]));
  await assert.rejects(store.addDomain('0'.repeat(64), { ...input, domain: 'missing.example' }, 'admin@example.org'), { code: 'FORBIDDEN' });
  await assert.rejects(store.addDomain('', input, 'admin@example.org'), { code: 'INVALID_PARTNER' });
  await assert.rejects(store.addDomain(id, input, 'admin@example.org'), { code: 'DOMAIN_EXISTS' });
  await assert.rejects(store.setDomainStatus(input.domain, 'pending', 'admin@example.org'), { code: 'INVALID_STATUS' });
  assert.equal(JSON.stringify([...db.collections].map(([name, values]) => [name, [...values]])), beforeFailedAdd);
  const edit = { domain: input.domain, organizationName: '変更した組織', contactEmail: 'contact@example.com', notes: '備考\n二行目' };
  await assert.rejects(store.updateDomain('other', edit), { code: 'FORBIDDEN' });
  await assert.rejects(store.updateDomain(id, { ...edit, contactEmail: 'invalid' }));
  assert.deepEqual((await store.collection('corporateDomains').doc(input.domain).get()).data(), beforeDomain);
  await store.updateDomain(id, edit);
  await store.updateDomain(id, edit);
  assert.deepEqual((await store.collection('corporateDomains').doc(input.domain).get()).data(),
    { ...beforeDomain, organizationName: edit.organizationName, contactEmail: edit.contactEmail, notes: edit.notes });
  await store.updateDomain(null, { ...edit, contactEmail: '', notes: '' });
  assert.equal((await store.entitlement(user)).partnerID, id);
  await store.collection('corporateUsageMonths').doc(`${id}_${input.domain}_2026-09`).set({ realtime: 6000 });
  await store.collection('corporateUsageMonths').doc(`${id}_${input.domain}_2026-08`).set({ realtime: 99000 });
  await store.collection('corporateUsageLedger').doc('current').set({ domain: input.domain,
    partnerID: id, operation: 'realtime', milliseconds: 6000, occurredAt: new Date(clock) });
  await store.collection('corporateUsageLedger').doc('previous').set({ domain: input.domain,
    partnerID: id, operation: 'realtime', milliseconds: 99000, occurredAt: new Date(clock - 31 * 86400000) });
  await store.collection('corporateDomains').doc('other.example').set({ partnerID: 'other' });
  const dashboard = await store.dashboard(id, '2026-09');
  assert.equal(dashboard.length, 1);
  assert.deepEqual(dashboard[0].usage, { realtime: 6000, mediaFile: 0, formalTranslation: 0 });
  const beforeAnnual = JSON.stringify([...db.collections].map(([name, values]) => [name, [...values]]));
  const annual = await store.yearlyUsage(id, 2026);
  assert.equal(annual.length, 1, '他の販売店を含まない');
  assert.deepEqual(annual[0].months.map(item => item.month), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(annual[0].months[0].total, 0, '未利用月も表示');
  assert.equal(annual[0].months[7].total, 99000);
  assert.equal(annual[0].months[8].total, 6000);
  assert.equal(annual[0].total, 105000);
  assert.equal((await store.yearlyUsage(id, 2025))[0].total, 0);
  for (const year of [0, 10000, 2026.5, NaN]) await assert.rejects(store.yearlyUsage(id, year));
  assert.equal(JSON.stringify([...db.collections].map(([name, values]) => [name, [...values]])), beforeAnnual,
    '一覧取得でデータを書き換えない');
  const savedDomain = (await store.collection('corporateDomains').doc(input.domain).get()).data();
  await store.setDomainStatus(input.domain, 'inactive', 'admin@example.org');
  await store.setDomainStatus(input.domain, 'active', 'admin@example.org');
  assert.deepEqual((await store.collection('corporateDomains').doc(input.domain).get()).data(), savedDomain,
    '再有効化しても所有者・初回有効日・上限・詳細情報を変更しない');
  assert.deepEqual(await store.yearlyUsage(id, 2026), annual, '状態変更で利用履歴が変わらない');
  for (const status of ['pending', 'rejected', 'suspended']) {
    await store.collection('corporateDomains').doc(input.domain).update({ status });
    assert.equal(await store.entitlement(user), null, '旧無効状態を自動で有効にしない');
  }
  await store.setDomainStatus(input.domain, 'active', 'admin@example.org');
  const expiredID = await store.invite('expired@example.net', '期限切れ');
  const expiredToken = sent.text.match(/token=([a-f0-9]{64})/)[1];
  clock += 24 * 60 * 60 * 1000;
  await assert.rejects(store.accept(expiredID, expiredToken, 'test-password'), { code: 'INVALID_INVITE' });
  assert.equal(await store.activePartner(expiredID), null);
  await store.collection('partners').doc(id).update({ status: 'suspended' });
  await assert.rejects(store.addDomain(id, { ...input, domain: 'disabled.example' }, 'admin@example.org'), { code: 'FORBIDDEN' });
  assert.equal((await store.collection('corporateDomains').doc('disabled.example').get()).exists, false);
  console.log('販売店ストア: 管理者追加・重複保全・招待・有効／無効の隔離テスト成功（本番通信なし）');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
