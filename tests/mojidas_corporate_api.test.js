const assert = require('assert');
const express = require('express');
const { randomUUID } = require('crypto');
const { request, listen } = require('./partner_http_helper');
const { TransactionalFirestore } = require('./mojidas_credit_integrity.test');
const { MojidasCreditStore } = require('../modules/credit/mojidas_credit_store');
const { CorporateUsageStore } = require('../modules/partners/corporate_usage_store');
const { PartnerStore } = require('../modules/partners/partner_store');
const { mojidasCollectionPath } = require('../modules/mojidas_firestore');
const { createMojidasRouter } = require('../routes/api/mojidas');

async function main() {
  const db = new TransactionalFirestore(), now = Date.UTC(2026, 8, 15);
  const options = { firestoreProvider: () => db, now: () => now };
  const base = new MojidasCreditStore(options), partners = new PartnerStore(options);
  const collection = name => db.collection(mojidasCollectionPath(name));
  await collection('partners').doc('dealer').set({ status: 'active' });
  const domain = collection('corporateDomains').doc('example.co.jp');
  await domain.set({ status: 'pending', partnerID: 'dealer', organizationName: '組織' });
  const user = { uid: 'member', email: 'member@example.co.jp', emailVerified: true,
    metadata: { creationTime: new Date(now).toISOString() } };
  const session = { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600,
    user: { id: user.uid, email: user.email, emailVerified: true } };
  const app = express(); app.use(express.json());
  let checkoutCalls = 0, lookupFailed = false;
  app.use(createMojidasRouter({
    creditStore: base, corporateUsageStore: new CorporateUsageStore(options),
    partnerStore: { entitlement: u => { if (lookupFailed) throw new Error('offline'); return partners.entitlement(u); } },
    userStore: { recordLogin: async () => {} }, versionStore: { recordClientInfo: async () => {} },
    apiKeyIssuer: { issue: async () => ({ appKey: 'fixture' }) },
    translationService: {
      estimateFormal: async () => ({ billableMilliseconds: 5000 }),
      translateFormal: async () => ({ billableMilliseconds: 5000, blocks: [] }),
    },
    billingService: { createCheckoutSession: async () => { checkoutCalls++; return {}; } },
    authClient: { login: async () => session, refresh: async () => session, confirmEmailCode: async () => session,
      verifyAccessToken: async token => ({ ...user, uid: token }), publicUser: u => ({ id: u.uid, email: u.email, emailVerified: u.emailVerified }) },
  }));
  const server = await listen(app);
  const post = (path, body, token) => request(server, path, { method: 'POST', body, token });
  const reserve = () => ({ mode: 'realtime', clientSessionID: randomUUID(), recognitionRunID: randomUUID(), requestedMilliseconds: 0, trackCount: 1 });
  try {
    await base.grantCredit({ userID: user.uid, type: 'purchased', milliseconds: 5000, idempotencyKey: 'purchase' });
    const personalArgs = reserve();
    const personal = await post('/usage/reservations', personalArgs); assert.equal(personal.status, 201);
    await domain.update({ status: 'approved' });
    for (const [path, body] of [['/auth/login', { email: user.email, password: 'password' }],
      ['/auth/refresh', { refreshToken: 'refresh' }], ['/auth/verify-email', { email: user.email, code: '123456' }]]) {
      const result = await post(path, body); assert.equal(result.status, 200, result.text);
      assert.equal(result.body.user.isCorporate, true); assert.equal(result.body.accessToken, session.accessToken);
      assert.equal(result.body.refreshToken, session.refreshToken); assert.equal(result.body.expiresIn, session.expiresIn);
    }
    assert.equal((await request(server, '/me')).body.user.isCorporate, true);
    const balance = await request(server, '/credits/balance'); assert(balance.body.isCorporate && balance.body.isUnlimited);
    assert.equal((await post('/billing/checkout-session', { productID: 'fixture' })).status, 409); assert.equal(checkoutCalls, 0);
    assert.equal((await post('/usage/reservations', personalArgs)).body.id, personal.body.id);
    assert.equal((await post(`/usage/${personal.body.id}/complete`, { consumedMilliseconds: 2000 })).status, 200);
    const preserved = JSON.stringify(db.records(mojidasCollectionPath('creditGrants')));
    const corpArgs = reserve(), corp = await post('/usage/reservations', corpArgs);
    assert.equal(corp.status, 201); assert(corp.body.isCorporate && corp.body.isUnlimited);
    assert.equal((await post('/acp/instant-appkey', { reservationID: corp.body.id })).status, 200);
    assert.equal((await post('/acp/instant-appkey', { reservationID: corp.body.id }, 'other')).status, 404);
    for (const consumed of [0, 3000, 10000]) {
      const file = await post('/usage/reservations', { ...reserve(), mode: 'mediaFile', requestedMilliseconds: 10000 });
      assert.equal(file.status, 201);
      const endpoint = consumed === 3000 ? 'complete' : 'cancel';
      assert.equal((await post(`/usage/${file.body.id}/${endpoint}`, { consumedMilliseconds: consumed })).status, 200);
    }
    let formal = await post('/translation/formal', { sourceSessionID: randomUUID(), idempotencyKey: randomUUID() });
    for (let i = 0; i < 20 && formal.status === 202; i++)
      formal = await request(server, `/translation/formal/jobs/${formal.body.jobID}`);
    assert.equal(formal.status, 200, formal.text); assert.equal(formal.body.isUnlimited, true);
    assert.equal(formal.body.chargedMilliseconds, 5000);
    const formalRow = db.records(mojidasCollectionPath('corporateReservations')).find(row => row.data.operation === 'formalTranslation');
    assert.equal((await post(`/usage/${formalRow.id}/complete`, { consumedMilliseconds: 0 })).status, 403);
    const totals = db.records(mojidasCollectionPath('corporateUsageMonths'))[0].data;
    assert.equal(totals.mediaFile, 13000); assert.equal(totals.formalTranslation, 5000);
    await domain.update({ limitMilliseconds: 0, stopAtLimit: true });
    const blockedBalance = await request(server, '/credits/balance');
    assert.equal(blockedBalance.body.isCorporate, true);
    assert.equal(blockedBalance.body.usageAllowed, false);
    assert.equal(blockedBalance.body.availableMilliseconds, 0);
    assert.equal(blockedBalance.body.usageBlockedReason, 'CORPORATE_LIMIT_REACHED');
    assert.equal((await post('/usage/reservations', reserve())).status, 409);
    assert.equal((await post(`/usage/${corp.body.id}/heartbeat`, { sequence: 1, consumedMilliseconds: 6000 })).status, 409);
    assert.equal((await post('/auth/login', { email: user.email, password: 'password' })).status, 200);
    await domain.update({ limitMilliseconds: null, stopAtLimit: false });
    await domain.update({ status: 'suspended' });
    assert.equal((await post('/usage/reservations', corpArgs)).body.id, corp.body.id);
    for (let retry = 0; retry < 2; retry++) assert.equal((await post(`/usage/${corp.body.id}/heartbeat`, { sequence: 1, consumedMilliseconds: 6000 })).status, 200);
    assert.equal((await post(`/usage/${corp.body.id}/complete`, { consumedMilliseconds: 7000 })).status, 200);
    assert.equal(db.records(mojidasCollectionPath('corporateUsageMonths'))[0].data.realtime, 7000);
    assert.equal(JSON.stringify(db.records(mojidasCollectionPath('creditGrants'))), preserved);
    assert.equal((await request(server, '/credits/balance')).body.isCorporate, false);
    const forged = await post('/usage/reservations', { ...reserve(), isCorporate: true, corporate: { domain: 'example.co.jp', partnerID: 'dealer' } });
    assert.equal(forged.status, 201); assert(!forged.body.isCorporate);
    lookupFailed = true;
    const fallback = await post('/auth/login', { email: user.email, password: 'password' });
    assert.equal(fallback.status, 200); assert(!Object.hasOwn(fallback.body.user, 'isCorporate'));
    assert.equal((await post('/usage/reservations', reserve())).status, 500);
    console.log('法人API: 認証互換・開始区分固定・解除・所有者・二重集計・個人残高保全・偽装拒否・障害時停止を確認');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
