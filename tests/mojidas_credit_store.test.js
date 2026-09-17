const assert = require('assert');

const {
  MEDIA_RESERVATION_GRACE_MILLISECONDS,
  MONTHLY_FREE_MILLISECONDS,
  MojidasCreditStore,
  UNLIMITED_AVAILABLE_MILLISECONDS,
  monthlyPeriod,
} = require('../modules/credit/mojidas_credit_store');

class FakeFirestore {
  constructor() {
    this.collections = new Map();
  }

  collection(name) {
    return new FakeCollection(this, name);
  }

  async runTransaction(callback) {
    return callback({
      get: (reference) => reference.get(),
      set: (reference, value, options) => reference.set(value, options),
      update: (reference, value) => reference.update(value),
      delete: (reference) => reference.delete(),
    });
  }

  records(name) {
    return Array.from(this.map(name).entries()).map(([id, data]) => ({ id, data }));
  }

  map(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
    return this.collections.get(name);
  }
}

class FakeCollection {
  constructor(firestore, name) {
    this.firestore = firestore;
    this.name = name;
  }

  doc(id) {
    return new FakeDocument(this.firestore, this.name, id);
  }

  where(field, operator, value) {
    return new FakeQuery(this.firestore, this.name, field, value, operator);
  }
}

class FakeDocument {
  constructor(firestore, collectionName, id) {
    this.firestore = firestore;
    this.collectionName = collectionName;
    this.id = id;
  }

  async get() {
    const value = this.firestore.map(this.collectionName).get(this.id);
    return snapshot(this, value);
  }

  async set(value, options) {
    const records = this.firestore.map(this.collectionName);
    const previous = records.get(this.id);
    records.set(this.id, options && options.merge ? { ...previous, ...value } : { ...value });
  }

  async update(value) {
    const records = this.firestore.map(this.collectionName);
    const previous = records.get(this.id);
    assert(previous, `Missing document: ${this.collectionName}/${this.id}`);
    records.set(this.id, { ...previous, ...value });
  }

  async delete() {
    this.firestore.map(this.collectionName).delete(this.id);
  }
}

class FakeQuery {
  constructor(firestore, collectionName, field, value, operator = '==') {
    this.firestore = firestore;
    this.collectionName = collectionName;
    this.field = field;
    this.value = value;
    this.filters = [[field, operator, value]];
  }

  where(field, operator, value) {
    const query = new FakeQuery(this.firestore, this.collectionName, this.field, this.value);
    query.filters = [...this.filters, [field, operator, value]];
    return query;
  }

  async get() {
    const docs = this.firestore.records(this.collectionName)
      .filter((record) => this.filters.every(([field, operator, value]) => {
        const actual = record.data[field];
        if (operator === '==') return actual === value;
        if (operator === '>=') return actual >= value;
        if (operator === '<') return actual < value;
        throw new Error(`未対応の比較: ${operator}`);
      }))
      .map((record) => snapshot(
        new FakeDocument(this.firestore, this.collectionName, record.id),
        record.data
      ));
    return { docs };
  }
}

function snapshot(reference, value) {
  return {
    id: reference.id,
    ref: reference,
    exists: Boolean(value),
    data: () => value,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function testRenewalDuringExpiration(isUnlimited) {
  let now = Date.parse('2026-09-10T00:00:00Z');
  const startedAt = now;
  const firestore = new FakeFirestore();
  const store = new MojidasCreditStore({
    firestoreProvider: () => firestore,
    now: () => now,
  });
  const account = {
    userID: 'expiration-race-user',
    accountCreatedAt: new Date(now),
    isUnlimited,
  };
  const reservation = await store.createReservation({
    ...account,
    operation: 'realtime',
    clientSessionID: 'expiration-race-session',
    recognitionRunID: 'expiration-race-run',
    requestedMilliseconds: 0,
    trackCount: 1,
  });
  const heartbeatEntered = deferred();
  const heartbeatGate = deferred();
  const expirationEntered = deferred();
  const expirationGate = deferred();
  const originalTransaction = firestore.runTransaction.bind(firestore);
  let transactionCount = 0;
  firestore.runTransaction = async (callback) => {
    transactionCount++;
    // 月次付与の確認後、期限内に開始したheartbeatの更新を待機させる。
    if (transactionCount === 2) {
      heartbeatEntered.resolve();
      await heartbeatGate.promise;
    }
    return originalTransaction(callback);
  };
  const originalFinalize = store.finalizeReservation.bind(store);
  store.finalizeReservation = async (args) => {
    if (args.status === 'expired') {
      expirationEntered.resolve();
      await expirationGate.promise;
    }
    return originalFinalize(args);
  };

  now = startedAt + 599000;
  const heartbeat = store.heartbeat({
    reservationID: reservation.id,
    userID: account.userID,
    accountCreatedAt: account.accountCreatedAt,
    sequence: 1,
    consumedMilliseconds: 1000,
  });
  await heartbeatEntered.promise;
  now = startedAt + 600001;
  const expiration = store.releaseExpiredReservations(account.userID);
  await expirationEntered.promise;
  heartbeatGate.resolve();
  await heartbeat;
  const persistedAfterRenewal = structuredClone(firestore.collections);
  expirationGate.resolve();
  await expiration;

  // 古い期限切れ候補によって、予約・残高・台帳のどれも変更されない。
  assert.deepStrictEqual(firestore.collections, persistedAfterRenewal);
  const active = await store.assertActiveReservation({
    reservationID: reservation.id,
    userID: account.userID,
  });
  assert.strictEqual(Boolean(active.unlimited), isUnlimited);
  assert.strictEqual(active.status, 'consuming');

  // 更新後の期限を過ぎれば通常どおり終了し、再実行しても二重処理しない。
  now = active.leaseExpiresAt.getTime() + 1;
  await store.releaseExpiredReservations(account.userID);
  const expired = firestore.records('Mojidas/production/creditReservations')[0];
  assert.strictEqual(expired.data.status, 'expired');
  const persistedAfterExpiration = structuredClone(firestore.collections);
  await store.releaseExpiredReservations(account.userID);
  assert.deepStrictEqual(firestore.collections, persistedAfterExpiration);
}

async function testSignupGift() {
  const firestore = new FakeFirestore();
  let now = Date.parse('2026-09-13T00:00:00Z');
  const store = new MojidasCreditStore({ firestoreProvider: () => firestore, now: () => now });
  const old = { userID: 'old', accountCreatedAt: new Date(now - 1000) };
  await store.getBalance(old);
  await store.activateSignupGift();
  const policy = firestore.records('Mojidas/production/configuration')[0];
  now += 1000;
  await store.activateSignupGift();
  assert.deepStrictEqual(firestore.records('Mojidas/production/configuration')[0], policy);
  assert.strictEqual((await store.getBalance(old)).availableMilliseconds, MONTHLY_FREE_MILLISECONDS);
  const fresh = { userID: 'new', accountCreatedAt: new Date(now) };
  let balance = await store.getBalance(fresh);
  assert.strictEqual(balance.availableMilliseconds, MONTHLY_FREE_MILLISECONDS + 3600000);
  assert.strictEqual(balance.purchasedMilliseconds, 0);
  assert.strictEqual(balance.grants.find(item => item.type === 'promotional').expiresAt, null);
  const before = structuredClone(firestore.collections);
  await store.getBalance(fresh);
  assert.deepStrictEqual(firestore.collections, before);
  // 消費済み残高を再ログイン・再起動で元に戻さない。
  const gift = firestore.records('Mojidas/production/creditGrants').find(item => item.data.type === 'promotional');
  firestore.map('Mojidas/production/creditGrants').get(gift.id).remainingMilliseconds = 123;
  const restarted = new MojidasCreditStore({ firestoreProvider: () => firestore, now: () => now });
  await restarted.getBalance(fresh);
  assert.strictEqual(firestore.map('Mojidas/production/creditGrants').get(gift.id).remainingMilliseconds, 123);
  assert.strictEqual(firestore.records('Mojidas/production/usageLedger').filter(item => item.data.metadata.type === 'promotional').length, 1);
  // 付与トランザクションの失敗後も次の残高取得で回復する。
  const retryUser = { userID: 'retry', accountCreatedAt: new Date(now) };
  const transaction = firestore.runTransaction.bind(firestore);
  let fail = true;
  firestore.runTransaction = async callback => {
    if (fail) { fail = false; throw new Error('fixture transaction failure'); }
    return transaction(callback);
  };
  await assert.rejects(() => restarted.ensureSignupGift(retryUser));
  await restarted.getBalance(retryUser);
  assert.strictEqual(firestore.records('Mojidas/production/creditGrants').filter(item => item.data.userID === 'retry' && item.data.type === 'promotional').length, 1);
  assert.strictEqual((await restarted.getBalance(old)).availableMilliseconds, MONTHLY_FREE_MILLISECONDS);
}

async function main() {
  await testSignupGift();
  await testRenewalDuringExpiration(false);
  await testRenewalDuringExpiration(true);
  const januaryAnchor = new Date('2026-01-31T10:15:00.000Z');
  let period = monthlyPeriod(januaryAnchor, new Date('2026-02-15T00:00:00.000Z'));
  assert.strictEqual(period.startsAt.toISOString(), '2026-01-31T10:15:00.000Z');
  assert.strictEqual(period.expiresAt.toISOString(), '2026-02-28T10:15:00.000Z');
  period = monthlyPeriod(januaryAnchor, new Date('2026-03-15T00:00:00.000Z'));
  assert.strictEqual(period.startsAt.toISOString(), '2026-02-28T10:15:00.000Z');
  assert.strictEqual(period.expiresAt.toISOString(), '2026-03-31T10:15:00.000Z');

  const configuredFreeFirestore = new FakeFirestore();
  const configuredFreeStore = new MojidasCreditStore({
    firestoreProvider: () => configuredFreeFirestore,
    now: () => Date.parse('2026-02-15T00:00:00.000Z'),
    monthlyFreeAllowanceMilliseconds: 30 * 60 * 1000,
  });
  const configuredFreeBalance = await configuredFreeStore.getBalance({
    userID: 'configured-free-user',
    accountCreatedAt: new Date('2026-02-01T00:00:00.000Z'),
  });
  assert.strictEqual(configuredFreeBalance.availableMilliseconds, 30 * 60 * 1000);

  const multipleGrantFirestore = new FakeFirestore();
  const multipleGrantStore = new MojidasCreditStore({
    firestoreProvider: () => multipleGrantFirestore,
    now: () => Date.parse('2026-01-31T10:15:00.000Z'),
  });
  const multipleGrantAccount = {
    userID: 'multiple-grant-user',
    accountCreatedAt: januaryAnchor,
  };
  const earlyCampaignID = await multipleGrantStore.grantCredit({
    userID: multipleGrantAccount.userID,
    type: 'campaign',
    label: 'スタートキャンペーン',
    milliseconds: 120000,
    expiresAt: new Date('2026-02-05T00:00:00.000Z'),
    idempotencyKey: 'campaign:start:2026',
  });
  const laterCampaignID = await multipleGrantStore.grantCredit({
    userID: multipleGrantAccount.userID,
    type: 'campaign',
    label: '冬のキャンペーン',
    milliseconds: 180000,
    expiresAt: new Date('2026-02-20T00:00:00.000Z'),
    idempotencyKey: 'campaign:winter:2026',
  });
  const purchasedID = await multipleGrantStore.grantCredit({
    userID: multipleGrantAccount.userID,
    type: 'purchased',
    label: '購入分',
    milliseconds: 300000,
    idempotencyKey: 'stripe:checkout:test-1',
    metadata: { productID: 'test-product', totalJPY: 123 },
  });
  const purchasedRecord = multipleGrantFirestore
    .records('Mojidas/production/creditGrants')
    .find((record) => record.id === purchasedID);
  assert.deepStrictEqual(purchasedRecord.data.metadata, {
    productID: 'test-product',
    totalJPY: 123,
  });
  assert.strictEqual(
    await multipleGrantStore.grantCredit({
      userID: multipleGrantAccount.userID,
      type: 'campaign',
      label: 'スタートキャンペーン',
      milliseconds: 120000,
      expiresAt: new Date('2026-02-05T00:00:00.000Z'),
      idempotencyKey: 'campaign:start:2026',
    }),
    earlyCampaignID
  );
  assert.strictEqual(
    multipleGrantFirestore.records('Mojidas/production/creditGrants').length,
    3
  );

  let multipleBalance = await multipleGrantStore.getBalance(multipleGrantAccount);
  assert.strictEqual(multipleBalance.grants.length, 4);
  assert.strictEqual(multipleBalance.grants[0].id, earlyCampaignID);
  assert.strictEqual(multipleBalance.grants[0].label, 'スタートキャンペーン');
  assert.strictEqual(multipleBalance.grants[1].id, laterCampaignID);
  assert.strictEqual(multipleBalance.grants[3].id, purchasedID);
  assert.strictEqual(multipleBalance.grants[3].expiresAt, null);

  const multipleGrantReservation = await multipleGrantStore.createReservation({
    ...multipleGrantAccount,
    operation: 'realtime',
    clientSessionID: '550e8400-e29b-41d4-a716-446655440001',
    recognitionRunID: '6ba7b810-9dad-41d1-80b4-00c04fd430c9',
    requestedMilliseconds: 250000,
    trackCount: 1,
  });
  const reservationRecord = multipleGrantFirestore
    .records('Mojidas/production/creditReservations')
    .find((record) => record.id === multipleGrantReservation.id);
  assert.strictEqual(multipleGrantReservation.requestedMilliseconds, 0);
  assert.deepStrictEqual(reservationRecord.data.allocations, []);
  let balanceBeforeRealtimeCompletion = await multipleGrantStore.getBalance(
    multipleGrantAccount
  );
  assert.strictEqual(
    balanceBeforeRealtimeCompletion.availableMilliseconds,
    MONTHLY_FREE_MILLISECONDS + 600000
  );
  await multipleGrantStore.completeReservation({
    reservationID: multipleGrantReservation.id,
    userID: multipleGrantAccount.userID,
    consumedMilliseconds: 250000,
  });
  multipleBalance = await multipleGrantStore.getBalance(multipleGrantAccount);
  assert.strictEqual(multipleBalance.grants.find((grant) => grant.id === earlyCampaignID), undefined);
  assert.strictEqual(
    multipleBalance.grants.find((grant) => grant.id === laterCampaignID).remainingMilliseconds,
    50000
  );
  assert.strictEqual(
    multipleBalance.grants.find((grant) => grant.id === purchasedID).remainingMilliseconds,
    300000
  );

  const freePriorityRealtime = await multipleGrantStore.createReservation({
    ...multipleGrantAccount,
    operation: 'realtime',
    clientSessionID: '550e8400-e29b-41d4-a716-446655440002',
    recognitionRunID: '6ba7b810-9dad-41d1-80b4-00c04fd430ca',
    requestedMilliseconds: 300000,
    trackCount: 1,
  });
  assert.strictEqual(freePriorityRealtime.requestedMilliseconds, 0);
  await multipleGrantStore.completeReservation({
    reservationID: freePriorityRealtime.id,
    userID: multipleGrantAccount.userID,
    consumedMilliseconds: 100000,
  });
  multipleBalance = await multipleGrantStore.getBalance(multipleGrantAccount);
  assert.strictEqual(
    multipleBalance.grants.find((grant) => grant.type === 'monthlyFree')
      .remainingMilliseconds,
    MONTHLY_FREE_MILLISECONDS - 50000
  );
  assert.strictEqual(
    multipleBalance.grants.find((grant) => grant.id === purchasedID).remainingMilliseconds,
    300000
  );

  const firestore = new FakeFirestore();
  let now = Date.parse('2026-01-31T10:15:00.000Z');
  const store = new MojidasCreditStore({
    firestoreProvider: () => firestore,
    now: () => now,
  });
  const account = {
    userID: 'user-1',
    accountCreatedAt: januaryAnchor,
  };

  let balance = await store.getBalance(account);
  assert.strictEqual(balance.availableMilliseconds, MONTHLY_FREE_MILLISECONDS);
  assert.strictEqual(balance.expiringMilliseconds, MONTHLY_FREE_MILLISECONDS);
  assert.strictEqual(balance.purchasedMilliseconds, 0);
  assert.strictEqual(balance.grants.length, 1);
  await store.getBalance(account);
  assert.strictEqual(firestore.records('Mojidas/production/creditGrants').length, 1);
  assert.strictEqual(firestore.records('Mojidas/production/usageLedger').length, 1);

  const reservation = await store.createReservation({
    ...account,
    operation: 'realtime',
    clientSessionID: '550e8400-e29b-41d4-a716-446655440000',
    recognitionRunID: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
    requestedMilliseconds: 300000,
    trackCount: 1,
  });
  assert.strictEqual(reservation.requestedMilliseconds, 0);
  balance = await store.getBalance(account);
  assert.strictEqual(balance.availableMilliseconds, MONTHLY_FREE_MILLISECONDS);

  await store.heartbeat({
    reservationID: reservation.id,
    userID: account.userID,
    accountCreatedAt: account.accountCreatedAt,
    sequence: 1,
    consumedMilliseconds: 15000,
  });
  balance = await store.getBalance(account);
  assert.strictEqual(balance.availableMilliseconds, MONTHLY_FREE_MILLISECONDS - 15000);
  await store.completeReservation({
    reservationID: reservation.id,
    userID: account.userID,
    consumedMilliseconds: 30000,
  });
  balance = await store.getBalance(account);
  assert.strictEqual(balance.availableMilliseconds, MONTHLY_FREE_MILLISECONDS - 30000);

  await store.completeReservation({
    reservationID: reservation.id,
    userID: account.userID,
    consumedMilliseconds: 30000,
  });
  balance = await store.getBalance(account);
  assert.strictEqual(balance.availableMilliseconds, MONTHLY_FREE_MILLISECONDS - 30000);

  const extendedReservation = await store.createReservation({
    ...account,
    operation: 'realtime',
    clientSessionID: '550e8400-e29b-41d4-a716-446655440000',
    recognitionRunID: '6ba7b812-9dad-41d1-80b4-00c04fd430c8',
    requestedMilliseconds: 300000,
    trackCount: 1,
  });
  const extended = await store.heartbeat({
    reservationID: extendedReservation.id,
    userID: account.userID,
    accountCreatedAt: account.accountCreatedAt,
    sequence: 1,
    consumedMilliseconds: 240000,
  });
  assert.strictEqual(extended.requestedMilliseconds, 240000);
  await store.completeReservation({
    reservationID: extendedReservation.id,
    userID: account.userID,
    consumedMilliseconds: 250000,
  });
  balance = await store.getBalance(account);
  assert.strictEqual(balance.availableMilliseconds, MONTHLY_FREE_MILLISECONDS - 280000);

  const insufficientFirestore = new FakeFirestore();
  const insufficientStore = new MojidasCreditStore({
    firestoreProvider: () => insufficientFirestore,
    now: () => Date.parse('2026-01-31T10:15:00.000Z'),
  });
  const insufficientAccount = {
    userID: 'insufficient-user',
    accountCreatedAt: januaryAnchor,
  };
  const almostExhausted = await insufficientStore.createReservation({
    ...insufficientAccount,
    operation: 'realtime',
    clientSessionID: '550e8400-e29b-41d4-a716-446655440020',
    recognitionRunID: '6ba7b810-9dad-41d1-80b4-00c04fd43020',
    requestedMilliseconds: 0,
    trackCount: 1,
  });
  await insufficientStore.completeReservation({
    reservationID: almostExhausted.id,
    userID: insufficientAccount.userID,
    consumedMilliseconds: MONTHLY_FREE_MILLISECONDS - 10000,
  });
  const overBalance = await insufficientStore.createReservation({
    ...insufficientAccount,
    operation: 'realtime',
    clientSessionID: '550e8400-e29b-41d4-a716-446655440021',
    recognitionRunID: '6ba7b810-9dad-41d1-80b4-00c04fd43021',
    requestedMilliseconds: 0,
    trackCount: 1,
  });
  await assert.rejects(
    () => insufficientStore.heartbeat({
      reservationID: overBalance.id,
      userID: insufficientAccount.userID,
      accountCreatedAt: insufficientAccount.accountCreatedAt,
      sequence: 1,
      consumedMilliseconds: 15000,
    }),
    (error) => error.code === 'INSUFFICIENT_CREDIT'
      && error.details.requiredMilliseconds === 15000
      && error.details.availableMilliseconds === 10000
  );
  const exhaustedBalance = await insufficientStore.getBalance(insufficientAccount);
  assert.strictEqual(exhaustedBalance.availableMilliseconds, 0);
  await insufficientStore.completeReservation({
    reservationID: overBalance.id,
    userID: insufficientAccount.userID,
    consumedMilliseconds: 15000,
  });
  const exhaustedReservation = insufficientFirestore
    .records('Mojidas/production/creditReservations')
    .find((record) => record.id === overBalance.id);
  assert.strictEqual(exhaustedReservation.data.status, 'completed');
  assert.strictEqual(exhaustedReservation.data.consumedMilliseconds, 10000);

  await assert.rejects(
    () => store.createReservation({
      ...account,
      operation: 'mediaFile',
      clientSessionID: '550e8400-e29b-41d4-a716-446655440000',
      recognitionRunID: '6ba7b811-9dad-41d1-80b4-00c04fd430c8',
      requestedMilliseconds: 4000000,
      trackCount: 1,
    }),
    (error) => error.code === 'INSUFFICIENT_CREDIT'
      && error.details.availableMilliseconds === MONTHLY_FREE_MILLISECONDS - 280000
  );

  const mediaFirestore = new FakeFirestore();
  let mediaNow = Date.parse('2026-01-31T10:15:00.000Z');
  const mediaStore = new MojidasCreditStore({
    firestoreProvider: () => mediaFirestore,
    now: () => mediaNow,
  });
  const mediaAccount = {
    userID: 'media-user',
    accountCreatedAt: januaryAnchor,
  };
  await mediaStore.getBalance(mediaAccount);
  const failedMediaReservation = await mediaStore.createReservation({
    ...mediaAccount,
    operation: 'mediaFile',
    clientSessionID: '550e8400-e29b-41d4-a716-446655440010',
    recognitionRunID: '6ba7b810-9dad-41d1-80b4-00c04fd04310',
    requestedMilliseconds: 600000,
    trackCount: 1,
  });
  let mediaBalance = await mediaStore.getBalance(mediaAccount);
  assert.strictEqual(mediaBalance.availableMilliseconds, MONTHLY_FREE_MILLISECONDS - 600000);
  await mediaStore.heartbeat({
    reservationID: failedMediaReservation.id,
    userID: mediaAccount.userID,
    accountCreatedAt: mediaAccount.accountCreatedAt,
    sequence: 1,
    consumedMilliseconds: 400000,
  });
  let mediaReservationRecord = mediaFirestore
    .records('Mojidas/production/creditReservations')
    .find((record) => record.id === failedMediaReservation.id);
  assert.strictEqual(mediaReservationRecord.data.consumedMilliseconds, 0);
  await mediaStore.completeReservation({
    reservationID: failedMediaReservation.id,
    userID: mediaAccount.userID,
    consumedMilliseconds: 0,
    cancelled: true,
  });
  mediaBalance = await mediaStore.getBalance(mediaAccount);
  assert.strictEqual(mediaBalance.availableMilliseconds, MONTHLY_FREE_MILLISECONDS);

  const cancelledMediaReservation = await mediaStore.createReservation({
    ...mediaAccount,
    operation: 'mediaFile',
    clientSessionID: '550e8400-e29b-41d4-a716-446655440013',
    recognitionRunID: '6ba7b810-9dad-41d1-80b4-00c04fd04313',
    requestedMilliseconds: 600000,
    trackCount: 1,
  });
  await mediaStore.completeReservation({
    reservationID: cancelledMediaReservation.id,
    userID: mediaAccount.userID,
    consumedMilliseconds: 600000,
    cancelled: true,
  });
  mediaBalance = await mediaStore.getBalance(mediaAccount);
  assert.strictEqual(mediaBalance.availableMilliseconds, MONTHLY_FREE_MILLISECONDS - 600000);

  const completedMediaReservation = await mediaStore.createReservation({
    ...mediaAccount,
    operation: 'mediaFile',
    clientSessionID: '550e8400-e29b-41d4-a716-446655440011',
    recognitionRunID: '6ba7b810-9dad-41d1-80b4-00c04fd04311',
    requestedMilliseconds: 600000,
    trackCount: 1,
  });
  await mediaStore.completeReservation({
    reservationID: completedMediaReservation.id,
    userID: mediaAccount.userID,
    consumedMilliseconds: 240000,
  });
  mediaReservationRecord = mediaFirestore
    .records('Mojidas/production/creditReservations')
    .find((record) => record.id === completedMediaReservation.id);
  assert.strictEqual(mediaReservationRecord.data.consumedMilliseconds, 240000);
  mediaBalance = await mediaStore.getBalance(mediaAccount);
  assert.strictEqual(mediaBalance.availableMilliseconds, MONTHLY_FREE_MILLISECONDS - 840000);

  const expiredMediaReservation = await mediaStore.createReservation({
    ...mediaAccount,
    operation: 'mediaFile',
    clientSessionID: '550e8400-e29b-41d4-a716-446655440012',
    recognitionRunID: '6ba7b810-9dad-41d1-80b4-00c04fd04312',
    requestedMilliseconds: 600000,
    trackCount: 1,
  });
  await mediaStore.heartbeat({
    reservationID: expiredMediaReservation.id,
    userID: mediaAccount.userID,
    accountCreatedAt: mediaAccount.accountCreatedAt,
    sequence: 1,
    consumedMilliseconds: 500000,
  });
  mediaNow += 600000 + MEDIA_RESERVATION_GRACE_MILLISECONDS + 1;
  mediaBalance = await mediaStore.getBalance(mediaAccount);
  assert.strictEqual(mediaBalance.availableMilliseconds, MONTHLY_FREE_MILLISECONDS - 840000);
  mediaReservationRecord = mediaFirestore
    .records('Mojidas/production/creditReservations')
    .find((record) => record.id === expiredMediaReservation.id);
  assert.strictEqual(mediaReservationRecord.data.status, 'expired');
  assert.strictEqual(mediaReservationRecord.data.consumedMilliseconds, 0);

  const partialReservation = await store.createReservation({
    ...account,
    operation: 'realtime',
    clientSessionID: '550e8400-e29b-41d4-a716-446655440000',
    recognitionRunID: '6ba7b813-9dad-41d1-80b4-00c04fd430c8',
    requestedMilliseconds: 4000000,
    trackCount: 1,
  });
  assert.strictEqual(partialReservation.requestedMilliseconds, 0);
  await store.completeReservation({
    reservationID: partialReservation.id,
    userID: account.userID,
    consumedMilliseconds: 0,
    cancelled: true,
  });
  balance = await store.getBalance(account);
  assert.strictEqual(balance.availableMilliseconds, MONTHLY_FREE_MILLISECONDS - 280000);

  now = Date.parse('2026-02-28T10:15:00.000Z');
  balance = await store.getBalance(account);
  assert.strictEqual(balance.availableMilliseconds, MONTHLY_FREE_MILLISECONDS);
  assert.strictEqual(balance.grants.length, 1);
  assert.strictEqual(firestore.records('Mojidas/production/creditGrants').length, 2);

  const translationFirestore = new FakeFirestore();
  const translationStore = new MojidasCreditStore({
    firestoreProvider: () => translationFirestore,
    now: () => Date.parse('2026-08-22T00:00:00.000Z'),
  });
  const translationAccount = {
    userID: 'translation-user',
    accountCreatedAt: new Date('2026-08-01T00:00:00.000Z'),
  };
  const firstTranslationCharge = await translationStore.consumeTranslation({
    ...translationAccount,
    idempotencyKey: 'translation-request-1',
    requestFingerprint: '1'.repeat(64),
    milliseconds: 120000,
    sourceSessionID: 'source-session-1',
    targetLanguageCode: 'en',
  });
  assert.deepStrictEqual(firstTranslationCharge, {
    billableMilliseconds: 120000,
    chargedMilliseconds: 120000,
    isUnlimited: false,
    alreadyConsumed: false,
  });
  let translationBalance = await translationStore.getBalance(translationAccount);
  assert.strictEqual(
    translationBalance.availableMilliseconds,
    MONTHLY_FREE_MILLISECONDS - 120000
  );
  const translationLedgerCount = translationFirestore
    .records('Mojidas/production/usageLedger').length;
  const repeatedTranslationCharge = await translationStore.consumeTranslation({
    ...translationAccount,
    idempotencyKey: 'translation-request-1',
    requestFingerprint: '1'.repeat(64),
    milliseconds: 120000,
    sourceSessionID: 'source-session-1',
    targetLanguageCode: 'en',
  });
  assert.strictEqual(repeatedTranslationCharge.alreadyConsumed, true);
  translationBalance = await translationStore.getBalance(translationAccount);
  assert.strictEqual(
    translationBalance.availableMilliseconds,
    MONTHLY_FREE_MILLISECONDS - 120000
  );
  assert.strictEqual(
    translationFirestore.records('Mojidas/production/usageLedger').length,
    translationLedgerCount
  );
  await assert.rejects(
    () => translationStore.consumeTranslation({
      ...translationAccount,
      idempotencyKey: 'translation-request-1',
      requestFingerprint: '2'.repeat(64),
      milliseconds: 120000,
      sourceSessionID: 'source-session-1',
      targetLanguageCode: 'en',
    }),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT'
  );
  await assert.rejects(
    () => translationStore.consumeTranslation({
      ...translationAccount,
      idempotencyKey: 'translation-request-1',
      requestFingerprint: '1'.repeat(64),
      milliseconds: 120001,
      sourceSessionID: 'source-session-1',
      targetLanguageCode: 'en',
    }),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT'
  );
  await assert.rejects(
    () => translationStore.consumeTranslation({
      ...translationAccount,
      idempotencyKey: 'translation-too-large',
      requestFingerprint: '3'.repeat(64),
      milliseconds: MONTHLY_FREE_MILLISECONDS,
      sourceSessionID: 'source-session-1',
      targetLanguageCode: 'en',
    }),
    (error) => error.code === 'INSUFFICIENT_CREDIT'
      && error.details.availableMilliseconds === MONTHLY_FREE_MILLISECONDS - 120000
  );

  const cancelledTranslationReservation = await translationStore.createReservation({
    ...translationAccount,
    operation: 'formalTranslation',
    clientSessionID: 'translation-source-session-1',
    recognitionRunID: 'translation-reservation-1',
    requestedMilliseconds: 90000,
    trackCount: 1,
  });
  translationBalance = await translationStore.getBalance(translationAccount);
  assert.strictEqual(
    translationBalance.availableMilliseconds,
    MONTHLY_FREE_MILLISECONDS - 210000
  );
  const repeatedTranslationReservation = await translationStore.createReservation({
    ...translationAccount,
    operation: 'formalTranslation',
    clientSessionID: 'translation-source-session-1',
    recognitionRunID: 'translation-reservation-1',
    requestedMilliseconds: 90000,
    trackCount: 1,
  });
  assert.strictEqual(repeatedTranslationReservation.alreadyReserved, true);
  translationBalance = await translationStore.getBalance(translationAccount);
  assert.strictEqual(
    translationBalance.availableMilliseconds,
    MONTHLY_FREE_MILLISECONDS - 210000
  );
  await assert.rejects(
    () => translationStore.createReservation({
      ...translationAccount,
      operation: 'formalTranslation',
      clientSessionID: 'translation-source-session-1',
      recognitionRunID: 'translation-reservation-1',
      requestedMilliseconds: 90001,
      trackCount: 1,
    }),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT'
  );
  await translationStore.completeReservation({
    reservationID: cancelledTranslationReservation.id,
    userID: translationAccount.userID,
    consumedMilliseconds: 0,
    cancelled: true,
  });
  translationBalance = await translationStore.getBalance(translationAccount);
  assert.strictEqual(
    translationBalance.availableMilliseconds,
    MONTHLY_FREE_MILLISECONDS - 120000
  );

  const completedTranslationReservation = await translationStore.createReservation({
    ...translationAccount,
    operation: 'formalTranslation',
    clientSessionID: 'translation-source-session-1',
    recognitionRunID: 'translation-reservation-2',
    requestedMilliseconds: 90000,
    trackCount: 1,
  });
  await translationStore.completeReservation({
    reservationID: completedTranslationReservation.id,
    userID: translationAccount.userID,
    consumedMilliseconds: 90000,
    cancelled: false,
  });
  translationBalance = await translationStore.getBalance(translationAccount);
  assert.strictEqual(
    translationBalance.availableMilliseconds,
    MONTHLY_FREE_MILLISECONDS - 210000
  );

  const unlimitedFirestore = new FakeFirestore();
  const unlimitedStore = new MojidasCreditStore({
    firestoreProvider: () => unlimitedFirestore,
    now: () => Date.parse('2026-08-22T00:00:00.000Z'),
  });
  const unlimitedAccount = {
    userID: 'invited-user',
    accountCreatedAt: new Date('2026-08-01T00:00:00.000Z'),
    isUnlimited: true,
  };
  const unlimitedBalance = await unlimitedStore.getBalance(unlimitedAccount);
  assert.strictEqual(unlimitedBalance.isUnlimited, true);
  assert.strictEqual(
    unlimitedBalance.availableMilliseconds,
    UNLIMITED_AVAILABLE_MILLISECONDS + MONTHLY_FREE_MILLISECONDS
  );
  assert.strictEqual(unlimitedBalance.grants.length, 2);
  assert.strictEqual(
    unlimitedFirestore.records('Mojidas/production/creditGrants').length,
    2
  );

  const unlimitedReservation = await unlimitedStore.createReservation({
    ...unlimitedAccount,
    operation: 'realtime',
    clientSessionID: '550e8400-e29b-41d4-a716-446655440099',
    recognitionRunID: '6ba7b810-9dad-41d1-80b4-00c04fd43099',
    requestedMilliseconds: 300000,
    trackCount: 1,
  });
  assert.strictEqual(unlimitedReservation.isUnlimited, true);
  assert.strictEqual(unlimitedReservation.requestedMilliseconds, 0);
  let unlimitedRecord = unlimitedFirestore
    .records('Mojidas/production/creditReservations')[0];
  assert.deepStrictEqual(unlimitedRecord.data.allocations, []);
  assert.strictEqual(unlimitedRecord.data.unlimited, true);
  const unlimitedReserveLedger = unlimitedFirestore
    .records('Mojidas/production/usageLedger')
    .find((record) => record.data.kind === 'start');
  assert.strictEqual(unlimitedReserveLedger.data.milliseconds, 0);

  const extendedUnlimitedReservation = await unlimitedStore.heartbeat({
    reservationID: unlimitedReservation.id,
    userID: unlimitedAccount.userID,
    accountCreatedAt: unlimitedAccount.accountCreatedAt,
    sequence: 1,
    consumedMilliseconds: 290000,
  });
  assert.strictEqual(extendedUnlimitedReservation.requestedMilliseconds, 290000);
  await unlimitedStore.completeReservation({
    reservationID: unlimitedReservation.id,
    userID: unlimitedAccount.userID,
    consumedMilliseconds: 320000,
  });
  unlimitedRecord = unlimitedFirestore
    .records('Mojidas/production/creditReservations')[0];
  assert.strictEqual(unlimitedRecord.data.status, 'completed');
  assert.strictEqual(unlimitedRecord.data.consumedMilliseconds, 320000);
  assert.strictEqual(
    unlimitedFirestore.records('Mojidas/production/usageLedger')
      .filter((record) => record.data.kind === 'release').length,
    0
  );

  const unlimitedTranslationCharge = await unlimitedStore.consumeTranslation({
    ...unlimitedAccount,
    idempotencyKey: 'unlimited-translation',
    requestFingerprint: '4'.repeat(64),
    milliseconds: 45000,
    sourceSessionID: 'unlimited-source-session',
    targetLanguageCode: 'en',
  });
  assert.deepStrictEqual(unlimitedTranslationCharge, {
    billableMilliseconds: 45000,
    chargedMilliseconds: 45000,
    isUnlimited: true,
    alreadyConsumed: false,
  });
  const unlimitedTranslationLedger = unlimitedFirestore
    .records('Mojidas/production/usageLedger')
    .find((record) => record.data.metadata.operation === 'formalTranslation');
  assert.strictEqual(unlimitedTranslationLedger.data.milliseconds, -45000);

  console.log('Mojidasクレジットストア: 複数期限を含むすべてのテストに成功しました。');
}

module.exports = { FakeFirestore };
if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
