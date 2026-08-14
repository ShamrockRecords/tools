const assert = require('assert');

const {
  MONTHLY_FREE_MILLISECONDS,
  MojidasCreditStore,
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
    assert.strictEqual(operator, '==');
    return new FakeQuery(this.firestore, this.name, field, value);
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
  constructor(firestore, collectionName, field, value) {
    this.firestore = firestore;
    this.collectionName = collectionName;
    this.field = field;
    this.value = value;
  }

  async get() {
    const docs = this.firestore.records(this.collectionName)
      .filter((record) => record.data[this.field] === this.value)
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

async function main() {
  const januaryAnchor = new Date('2026-01-31T10:15:00.000Z');
  let period = monthlyPeriod(januaryAnchor, new Date('2026-02-15T00:00:00.000Z'));
  assert.strictEqual(period.startsAt.toISOString(), '2026-01-31T10:15:00.000Z');
  assert.strictEqual(period.expiresAt.toISOString(), '2026-02-28T10:15:00.000Z');
  period = monthlyPeriod(januaryAnchor, new Date('2026-03-15T00:00:00.000Z'));
  assert.strictEqual(period.startsAt.toISOString(), '2026-02-28T10:15:00.000Z');
  assert.strictEqual(period.expiresAt.toISOString(), '2026-03-31T10:15:00.000Z');

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
  assert.strictEqual(firestore.records('creditGrants').length, 1);
  assert.strictEqual(firestore.records('usageLedger').length, 1);

  const reservation = await store.createReservation({
    ...account,
    operation: 'realtime',
    clientSessionID: '550e8400-e29b-41d4-a716-446655440000',
    recognitionRunID: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
    requestedMilliseconds: 300000,
    trackCount: 1,
  });
  assert.strictEqual(reservation.requestedMilliseconds, 300000);
  balance = await store.getBalance(account);
  assert.strictEqual(balance.availableMilliseconds, 3300000);

  await store.heartbeat({
    reservationID: reservation.id,
    userID: account.userID,
    accountCreatedAt: account.accountCreatedAt,
    sequence: 1,
    consumedMilliseconds: 15000,
  });
  await store.completeReservation({
    reservationID: reservation.id,
    userID: account.userID,
    consumedMilliseconds: 30000,
  });
  balance = await store.getBalance(account);
  assert.strictEqual(balance.availableMilliseconds, 3570000);

  await store.completeReservation({
    reservationID: reservation.id,
    userID: account.userID,
    consumedMilliseconds: 30000,
  });
  balance = await store.getBalance(account);
  assert.strictEqual(balance.availableMilliseconds, 3570000);

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
  assert.strictEqual(extended.requestedMilliseconds, 600000);
  await store.completeReservation({
    reservationID: extendedReservation.id,
    userID: account.userID,
    consumedMilliseconds: 250000,
  });
  balance = await store.getBalance(account);
  assert.strictEqual(balance.availableMilliseconds, 3320000);

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
      && error.details.availableMilliseconds === 3320000
  );

  now = Date.parse('2026-02-28T10:15:00.000Z');
  balance = await store.getBalance(account);
  assert.strictEqual(balance.availableMilliseconds, MONTHLY_FREE_MILLISECONDS);
  assert.strictEqual(balance.grants.length, 1);
  assert.strictEqual(firestore.records('creditGrants').length, 2);

  console.log('Mojidasクレジットストア: 23件のテストに成功しました。');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
