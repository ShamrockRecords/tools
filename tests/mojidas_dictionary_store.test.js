const assert = require('assert');

const {
  MojidasDictionaryStore,
  MAXIMUM_WORD_COUNT,
} = require('../modules/dictionary/mojidas_dictionary_store');

class FakeFirestore {
  constructor() { this.collections = new Map(); }
  collection(name) { return new FakeCollection(this, name); }
  async runTransaction(callback) {
    return callback({
      get: (reference) => reference.get(),
      set: (reference, value, options) => reference.set(value, options),
    });
  }
  map(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
    return this.collections.get(name);
  }
}

class FakeCollection {
  constructor(firestore, name) { this.firestore = firestore; this.name = name; }
  doc(id) { return new FakeDocument(this.firestore, this.name, id); }
  where(field, operator, value) {
    return new FakeQuery(this.firestore, this.name, [{ field, operator, value }]);
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
    const previous = records.get(this.id) || {};
    records.set(this.id, options && options.merge ? { ...previous, ...value } : { ...value });
  }
  collection(name) {
    return new FakeCollection(this.firestore, `${this.collectionName}/${this.id}/${name}`);
  }
}

class FakeQuery {
  constructor(firestore, collectionName, filters, order) {
    this.firestore = firestore;
    this.collectionName = collectionName;
    this.filters = filters;
    this.order = order;
  }
  where(field, operator, value) {
    return new FakeQuery(
      this.firestore,
      this.collectionName,
      [...this.filters, { field, operator, value }],
      this.order
    );
  }
  orderBy(field, direction) {
    return new FakeQuery(
      this.firestore,
      this.collectionName,
      this.filters,
      { field, direction }
    );
  }
  async get() {
    let entries = Array.from(this.firestore.map(this.collectionName).entries())
      .filter(([, value]) => this.filters.every((filter) => {
        if (filter.operator === '==') return value[filter.field] === filter.value;
        if (filter.operator === '>') return value[filter.field] > filter.value;
        throw new Error(`Unsupported operator: ${filter.operator}`);
      }));
    if (this.order) {
      const multiplier = this.order.direction === 'desc' ? -1 : 1;
      entries = entries.sort((lhs, rhs) => (
        lhs[1][this.order.field] - rhs[1][this.order.field]
      ) * multiplier);
    }
    const docs = entries
      .map(([id, value]) => snapshot(
        new FakeDocument(this.firestore, this.collectionName, id),
        value
      ));
    return { docs };
  }
}

function snapshot(reference, value) {
  return {
    id: reference.id,
    ref: reference,
    exists: value !== undefined,
    data: () => value,
  };
}

async function main() {
  let now = Date.parse('2026-08-22T00:00:00.000Z');
  const firestore = new FakeFirestore();
  const store = new MojidasDictionaryStore({
    firestoreProvider: () => firestore,
    now: () => now,
  });
  const userID = 'account-a';
  const deviceA = '11111111-1111-4111-8111-111111111111';
  const deviceB = '22222222-2222-4222-8222-222222222222';
  const wordID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  let result = await store.synchronize({
    userID,
    deviceID: deviceA,
    mutations: [{
      sequence: 1,
      wordID,
      operation: 'upsert',
      written: '練馬ベース',
      spoken: 'ネリマベース',
      isEnabled: true,
    }],
  });
  assert.strictEqual(result.revision, 1);
  assert.strictEqual(result.acceptedThroughSequence, 1);

  // 同じ端末の再送は冪等で、サーバーリビジョンを進めない。
  result = await store.synchronize({
    userID,
    deviceID: deviceA,
    mutations: [{
      sequence: 1,
      wordID,
      operation: 'upsert',
      written: '練馬ベース',
      spoken: 'ネリマベース',
      isEnabled: true,
    }],
  });
  assert.strictEqual(result.revision, 1);

  let changes = await store.getChanges({ userID, afterRevision: 0 });
  assert.strictEqual(changes.changes.length, 1);
  assert.strictEqual(changes.changes[0].written, '練馬ベース');

  // 別端末での更新は、端末時計ではなくサーバー受付順で後勝ちになる。
  now += 1000;
  await store.synchronize({
    userID,
    deviceID: deviceB,
    mutations: [{
      sequence: 1,
      wordID,
      operation: 'upsert',
      written: 'Nerima Base',
      spoken: 'ネリマベース',
      isEnabled: false,
    }],
  });
  changes = await store.getChanges({ userID, afterRevision: 1 });
  assert.strictEqual(changes.changes.length, 1);
  assert.strictEqual(changes.changes[0].written, 'Nerima Base');
  assert.strictEqual(changes.changes[0].isEnabled, false);
  assert.strictEqual(changes.changes[0].serverRevision, 2);

  // 削除は物理削除せず、他端末へ伝搬する墓標として保存する。
  now += 1000;
  await store.synchronize({
    userID,
    deviceID: deviceA,
    mutations: [{ sequence: 2, wordID, operation: 'delete' }],
  });
  changes = await store.getChanges({ userID, afterRevision: 2 });
  assert.strictEqual(changes.changes.length, 1);
  assert.strictEqual(changes.changes[0].deleted, true);

  await assert.rejects(
    () => store.synchronize({
      userID,
      deviceID: deviceA,
      mutations: [{
        sequence: 4,
        wordID,
        operation: 'upsert',
        written: '順序違反',
        spoken: 'ジュンジョイハン',
      }],
    }),
    (error) => error.code === 'INVALID_SEQUENCE'
  );

  assert.strictEqual(MAXIMUM_WORD_COUNT, 1000);
  console.log('mojidas_dictionary_store tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
