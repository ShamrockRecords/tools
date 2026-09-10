const assert = require('assert');
const http = require('http');
const express = require('express');
const { randomUUID } = require('crypto');
const { createMojidasRouter } = require('../routes/api/mojidas');
const { MojidasCreditStore, RESERVATION_LEASE_MILLISECONDS } = require('../modules/credit/mojidas_credit_store');
const { TransactionalFirestore } = require('./mojidas_credit_integrity.test');

async function main() {
  let now = Date.parse('2026-09-10T00:00:00Z');
  const createdAt = new Date(now);
  const db = new TransactionalFirestore();
  const store = new MojidasCreditStore({ firestoreProvider: () => db, now: () => now, monthlyFreeAllowanceMilliseconds: 1000 });
  const app = express();
  app.use(express.json());
  app.use('/api/mojidas', createMojidasRouter({
    creditStore: store,
    authClient: {
      async verifyAccessToken(token) {
        return { uid: token, emailVerified: true, metadata: { creationTime: createdAt.toISOString() },
          customClaims: { mojidasInvitedUnlimited: token === 'invited-fixture' } };
      },
    },
  }));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  function request(user, method, path, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: `/api/mojidas/${path}`, method,
        headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' } }, res => {
        let content = '';
        res.on('data', data => { content += data; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(content || '{}') }));
      });
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  try {
    for (const user of ['paid-fixture', 'invited-fixture']) {
      await store.grantCredit({ userID: user, type: 'purchased', milliseconds: 4000, idempotencyKey: 'paid' });
      const initial = await request(user, 'GET', 'credits/balance');
      assert.strictEqual(initial.status, 200);
      const created = await request(user, 'POST', 'usage/reservations', {
        mode: 'realtime', clientSessionID: randomUUID(), recognitionRunID: randomUUID(), requestedMilliseconds: 0, trackCount: 1,
      });
      assert.strictEqual(created.status, 201);
      const path = `usage/${created.body.id}`;
      assert.strictEqual((await request(user, 'POST', `${path}/heartbeat`, { sequence: 1, consumedMilliseconds: 1200 })).status, 200);
      now += RESERVATION_LEASE_MILLISECONDS + 1;
      await request(user, 'GET', 'credits/balance');
      assert.strictEqual((await request(user, 'POST', `${path}/heartbeat`, { sequence: 2, consumedMilliseconds: 1500 })).status, 200);
      for (let retry = 0; retry < 2; retry += 1) {
        assert.strictEqual((await request(user, 'POST', `${path}/complete`, { consumedMilliseconds: 1600 })).status, 200);
      }
      const after = await request(user, 'GET', 'credits/balance');
      assert.strictEqual(after.body.availableMilliseconds, initial.body.availableMilliseconds - 1600);
      assert.strictEqual(after.body.expiringMilliseconds, 0);
      assert.strictEqual(after.body.purchasedMilliseconds, 3400);
      const closed = await request(user, 'POST', `${path}/heartbeat`, { sequence: 3, consumedMilliseconds: 1600 });
      assert.strictEqual(closed.status, 409);
      assert.strictEqual(closed.body.error.code, 'RESERVATION_CLOSED');

      const formal = await store.createReservation({ userID: user, accountCreatedAt: createdAt, isUnlimited: user === 'invited-fixture',
        operation: 'formalTranslation', clientSessionID: 'formal-session', recognitionRunID: 'formal-run', requestedMilliseconds: 500, trackCount: 1 });
      for (const endpoint of ['cancel', 'complete', 'heartbeat']) {
        const result = await request(user, 'POST', `usage/${formal.id}/${endpoint}`, { sequence: 1, consumedMilliseconds: 0 });
        assert.strictEqual(result.status, 403);
        assert.strictEqual(result.body.error.code, 'RESERVATION_SERVER_MANAGED');
      }
      const forbidden = await request('other-user', 'POST', `${path}/complete`, { consumedMilliseconds: 1600 });
      assert.strictEqual(forbidden.status, 404);
    }
    console.log('credit-api-integrity: HTTP経由で通常／無制限の同一通信・期限復旧・消費内訳・二重確定防止・正式翻訳保護を検証');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
