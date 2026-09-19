const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const { validateInquiry, InquiryStore, createInquiryService } = require('../modules/business_inquiry');
const { createBusinessInquiryRouter } = require('../routes/api/mojidas_business_inquiry');
const { request, listen } = require('./partner_http_helper');

const fixture = () => { const email = `contact@${crypto.randomUUID()}.example.co.jp`; return { requestID: crypto.randomUUID(), organization: 'テスト株式会社', name: '担当者', email, emailConfirmation: email, trialStartsAt: '2026-09-19T10:00', message: '<script>入力内容</script>\n改行', website: '' }; };

// 本番データは使用せず、transactionを直列化した隔離fixtureで保存処理も検証する。
function databaseFixture() {
  const rows = new Map();
  let pending = Promise.resolve();
  const database = {
    collection(path) { return { doc(id) {
      const key = `${path}/${id}`;
      return { key,
        async get() { return { exists: rows.has(key), data: () => rows.get(key) && { ...rows.get(key) } }; },
        async update(data) { assert(rows.has(key)); rows.set(key, { ...rows.get(key), ...data }); },
      };
    } }; },
    runTransaction(callback) {
      const next = pending.then(async () => {
        const writes = [];
        const result = await callback({ get: ref => { assert.equal(writes.length, 0); return ref.get(); }, create(ref, data) { assert(!rows.has(ref.key)); writes.push(() => rows.set(ref.key, { ...data })); }, update: (ref, data) => writes.push(() => ref.update(data)) });
        if (database.failCommit) { database.failCommit = false; throw new Error('commit failed'); }
        for (const write of writes) await write();
        return result;
      });
      pending = next.catch(() => {});
      return next;
    },
  };
  return database;
}

async function main() {
  for (const [start, end] of [['2026-01-31T10:00', '2026-02-28T10:00'], ['2028-01-31T10:00', '2028-02-29T10:00'], ['2026-12-19T23:00', '2027-01-19T23:00']])
    assert.equal(validateInquiry({ ...fixture(), trialStartsAt: start, trialEndsAt: '偽装' }).trialEndsAt, end);
  for (const trialStartsAt of [undefined, '', '2026-02-30T10:00', 'invalid']) assert.throws(() => validateInquiry({ ...fixture(), trialStartsAt }));
  for (const domain of ['gmail.com', 'GMAIL.COM', 'googlemail.com', 'yahoo.co.jp', 'yahoo.com', 'outlook.com', 'icloud.com', 'docomo.ne.jp', 'sub.gmail.com']) {
    const data = fixture(); data.email = data.emailConfirmation = `a@${domain}`;
    assert.throws(() => validateInquiry(data), /独自ドメイン/);
  }
  for (const changes of [{ emailConfirmation: 'other@example.co.jp' }, { organization: ' ' }, { name: 'a\nb' }, { message: 'a'.repeat(5001) }, { website: 'spam' }, { requestID: '../file' }, { email: 'a\r\n@example.com' }]) {
    assert.throws(() => validateInquiry({ ...fixture(), ...changes }));
  }
  const withoutPartner = validateInquiry(fixture());
  assert.deepEqual(validateInquiry({ ...withoutPartner, emailConfirmation: withoutPartner.email, referringPartner: ' ' }), withoutPartner, '空欄は旧フォームと同じ保存値');
  for (const referringPartner of ['a'.repeat(201), '販売店\n偽装', {}, null]) assert.throws(() => validateInquiry({ ...fixture(), referringPartner }));
  const data = validateInquiry({ ...fixture(), referringPartner: ' 正規販売店テスト ' });
  assert.equal(data.referringPartner, '正規販売店テスト');
  const generalInput = { ...fixture(), email: 'test@gmail.com', emailConfirmation: 'test@gmail.com', organization: undefined, inquiry: undefined, trial: true };
  const general = validateInquiry(generalInput, { general: true });
  assert.equal(general.trial, undefined, '削除された項目は保存しない');
  assert.equal(validateInquiry({ ...fixture(), message: '' }).message, '', '法人の内容は任意');
  assert.throws(() => validateInquiry({ ...generalInput, message: ' ' }, { general: true }));
  assert.throws(() => validateInquiry(generalInput), 'リクエスト内の値で法人ドメイン制限を回避できない');
  const generalDatabase = databaseFixture();
  const generalStore = new InquiryStore({ firestore: generalDatabase, general: true });
  const generalSent = [];
  const generalService = createInquiryService({ general: true, store: generalStore, mailer: { async send(mail) { generalSent.push(mail); } } });
  await generalService(general); await generalService(general);
  assert.equal(generalSent.length, 2);
  assert.equal(general.category, 'general');
  assert.throws(() => validateInquiry({ ...generalInput, category: 'invalid' }, { general: true }));
  for (const organization of [undefined, '', '   ']) assert.throws(() => validateInquiry({ ...generalInput, category: 'corporate', organization }, { general: true }), /法人・団体名/);
  const corporateContact = validateInquiry({ ...generalInput, organization: '法人テスト', requestID: crypto.randomUUID(), category: 'corporate' }, { general: true });
  const corporateSent = [];
  await createInquiryService({ general: true, store: generalStore, mailer: { async send(mail) { corporateSent.push(mail); } } })(corporateContact);
  assert(corporateSent.every(mail => mail.subject.includes('法人向けプランについてのお問い合わせ') && mail.text.includes('お問い合わせの種類：法人向けプランについてのお問い合わせ')));
  assert(corporateSent.every(mail => mail.text.includes('法人・団体名：法人テスト')));
  assert(generalSent.some(mail => mail.to === 'test@gmail.com'));
  assert(generalSent.every(mail => !mail.subject.includes('法人') && !mail.text.includes('トライアル')));
  assert(generalSent.every(mail => mail.text.includes(general.message)));
  assert.equal(await new InquiryStore({ firestore: generalDatabase }).read(general.requestID), undefined, '保存先を法人とは分離');
  const store = new InquiryStore({ firestore: databaseFixture() });
  const sent = [];
  const service = createInquiryService({ store, mailer: { async send(mail) { sent.push(mail); } } });
  await Promise.all([service(data), service(data)]);
  await service(data);
  assert.equal(sent.length, 2, '並行操作・再送でも宛先ごとに1通');
  assert(sent.every(mail => mail.subject.includes('トライアル')));
  assert(sent.every(mail => mail.text.includes('2026-09-19 10:00') && mail.text.includes('2026-10-19 10:00')));
  assert.equal((await store.read(data.requestID)).trialEndsAt, '2026-10-19T10:00');
  assert(sent.every(mail => mail.text.includes('販売店：正規販売店テスト')));
  assert.equal((await store.read(data.requestID)).referringPartner, data.referringPartner);
  assert.equal((await store.read(data.requestID)).notes, `${data.message}\n\n紹介販売店：${data.referringPartner}`);
  assert(sent.every(mail => mail.text.includes('備考：\n紹介販売店：正規販売店テスト')));
  await store.create(withoutPartner);
  assert.equal((await store.read(withoutPartner.requestID)).notes, undefined, '販売店未入力なら備考を追加しない');
  await assert.rejects(() => service({ ...data, referringPartner: '別の販売店' }), /重複/);
  assert.deepEqual(sent.map(mail => mail.to).sort(), ['app@mojidas.jp', data.email].sort());
  assert(sent.every(mail => mail.text.includes(data.organization) && mail.text.includes(data.message) && !mail.text.includes('ご用件：')));
  assert(sent.every(mail => !mail.html), 'ユーザー入力はプレーンテキストのみ');
  await assert.rejects(() => service({ ...data, name: '別の人' }), /重複/);
  const reopened = new InquiryStore({ firestore: store.database() });
  const domainRef = require('../modules/mojidas_firestore').mojidasCollection(store.database(), 'corporateDomains').doc(data.domain);
  const domainRow = (await domainRef.get()).data();
  assert.equal(domainRow.partnerID, 'self'); assert.equal(domainRow.plan, 'trial'); assert.equal(domainRow.status, 'suspended');
  assert.equal(domainRow.organizationName, data.organization); assert.equal(domainRow.contactEmail, data.email);
  assert.equal(domainRow.notes, '紹介販売店：正規販売店テスト');
  assert.equal(domainRow.validityStartsAt, Date.parse('2026-09-19T10:00:00+09:00'));
  assert.equal(domainRow.validityEndsAt, Date.parse('2026-10-19T10:00:00+09:00'));
  assert.equal(domainRow.limitMilliseconds, 36000000); assert.equal(domainRow.stopAtLimit, true);
  await domainRef.update({ status: 'approved', notes: '管理者の追記' });
  await service(data);
  assert.equal((await domainRef.get()).data().notes, '管理者の追記', '再送で管理者編集を戻さない');
  assert.equal((await domainRef.get()).data().status, 'approved');
  const duplicate = { ...data, requestID: crypto.randomUUID() };
  await assert.rejects(service(duplicate), /個別に確認/);
  assert.equal(await store.read(duplicate.requestID), undefined);
  assert.equal(sent.length, 2, '同ドメイン再申込ではメールを送らない');
  const failedSave = validateInquiry(fixture());
  store.database().failCommit = true;
  await assert.rejects(service(failedSave), /commit failed/);
  assert.equal(await store.read(failedSave.requestID), undefined);
  const failedDomain = require('../modules/mojidas_firestore').mojidasCollection(store.database(), 'corporateDomains').doc(failedSave.domain);
  assert.equal((await failedDomain.get()).exists, false);
  assert.equal(sent.length, 2);
  await service(failedSave);
  assert.equal((await failedDomain.get()).exists, true);
  assert.equal((await reopened.read(data.requestID)).organization, data.organization);
  assert.equal((await reopened.read(data.requestID)).customer, 'accepted');

  const failedData = validateInquiry(fixture());
  let fail = true;
  const attempts = [];
  const retry = createInquiryService({ store, mailer: { async send(mail) {
    attempts.push(mail.to);
    if (mail.to === failedData.email && fail) { fail = false; throw Object.assign(new Error(), { statusCode: 429 }); }
  } } });
  await assert.rejects(() => retry(failedData), /メール送信に失敗/);
  await retry(failedData);
  assert.deepEqual(attempts, ['app@mojidas.jp', failedData.email, failedData.email], '受付済みの管理者メールは再送しない');
  const unknownData = validateInquiry(fixture());
  let unknownAttempts = 0;
  const unknown = createInquiryService({ store, mailer: { async send() { unknownAttempts++; throw Object.assign(new Error(), { code: 'SENDGRID_TIMEOUT' }); } } });
  assert((await unknown(unknownData)).message.includes('確認できません'));
  await unknown(unknownData);
  assert.equal(unknownAttempts, 2, '配達結果が不明なメールは自動再送しない');
  const stoppedData = validateInquiry(fixture());
  await store.create(stoppedData); await store.claim(stoppedData.requestID, 'admin');
  const stoppedSent = [];
  await createInquiryService({ store, mailer: { async send(mail) { stoppedSent.push(mail.to); } } })(stoppedData);
  assert.deepEqual(stoppedSent, [stoppedData.email], '送信中にプロセスが停止した宛先は再送しない');

  const app = express(); app.use(express.json());
  let calls = 0;
  app.use('/inquiry', createBusinessInquiryRouter({ allowLocalhost: false, service: async () => { calls++; return { message: '受付' }; } }));
  app.use('/contact', createBusinessInquiryRouter({ general: true, allowLocalhost: false, service: async value => { assert.equal(value.email, 'test@gmail.com'); assert.equal(value.trial, undefined); return { message: '受付' }; } }));
  const server = await listen(app);
  try {
    const origin = { Origin: 'https://mojidas.jp' };
    assert.equal((await request(server, '/contact', { method: 'POST', body: generalInput, headers: origin })).status, 200);
    assert.equal((await request(server, '/contact', { method: 'POST', body: { ...generalInput, message: '' }, headers: origin })).status, 400);
    assert.equal((await request(server, '/inquiry', { method: 'OPTIONS', headers: origin })).status, 204);
    assert.equal((await request(server, '/inquiry', { method: 'POST', body: fixture(), headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request(server, '/inquiry', { method: 'POST', body: fixture(), headers: { Origin: 'http://localhost:3000' } })).status, 403);
    assert.equal((await request(server, '/inquiry', { method: 'POST', body: { ...fixture(), email: 'a@gmail.com', emailConfirmation: 'a@gmail.com' }, headers: origin })).status, 400);
    assert.equal(calls, 0);
    const ok = await request(server, '/inquiry', { method: 'POST', body: fixture(), headers: origin });
    assert.equal(ok.status, 200); assert.equal(ok.headers['access-control-allow-origin'], origin.Origin);
    assert.equal(ok.headers['cache-control'], 'no-store');
    for (let i = 0; i < 4; i++) await request(server, '/inquiry', { method: 'POST', body: fixture(), headers: origin });
    assert.equal((await request(server, '/inquiry', { method: 'POST', body: fixture(), headers: { ...origin, 'X-Forwarded-For': '1.2.3.4' } })).status, 429);
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('法人問い合わせ: ドメイン・入力検証、宛先、再送、部分失敗、保存、CORS・回数制限のテスト成功');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
