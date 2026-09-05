const assert = require('assert');

const {
  AccountDeletionError,
  MojidasAccountDeletionService,
} = require('../modules/auth/mojidas_account_deletion');

class FakeDocument {
  constructor(collection, id) {
    this.collection = collection;
    this.id = id;
    this.ref = this;
  }

  async get() {
    return { exists: this.collection.documents.has(this.id) };
  }

  async set(value) {
    this.collection.documents.set(this.id, value);
  }

  async delete() {
    this.collection.documents.delete(this.id);
  }
}

class FakeQuery {
  constructor(collection, field, value, limitValue = Infinity) {
    this.collection = collection;
    this.field = field;
    this.value = value;
    this.limitValue = limitValue;
  }

  limit(value) {
    return new FakeQuery(this.collection, this.field, this.value, value);
  }

  async get() {
    const docs = Array.from(this.collection.documents.entries())
      .filter(([, value]) => value[this.field] === this.value)
      .slice(0, this.limitValue)
      .map(([id]) => new FakeDocument(this.collection, id));
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

class FakeCollection {
  constructor() {
    this.documents = new Map();
  }

  doc(id) {
    return new FakeDocument(this, id);
  }

  where(field, operator, value) {
    assert.strictEqual(operator, '==');
    return new FakeQuery(this, field, value);
  }
}

class FakeFirestore {
  constructor() {
    this.collections = new Map();
    this.recursivelyDeleted = [];
  }

  collection(path) {
    if (!this.collections.has(path)) this.collections.set(path, new FakeCollection());
    return this.collections.get(path);
  }

  batch() {
    const deletions = [];
    return {
      delete(document) { deletions.push(document); },
      async commit() {
        for (const document of deletions) await document.delete();
      },
    };
  }

  async recursiveDelete(document) {
    this.recursivelyDeleted.push(document.id);
    await document.delete();
  }
}

async function main() {
  const firestore = new FakeFirestore();
  const authDeleted = [];
  const authDisabled = [];
  const authRevoked = [];
  const service = new MojidasAccountDeletionService({
    firestoreProvider: () => firestore,
    authProvider: () => ({
      async updateUser(userID, value) { authDisabled.push([userID, value]); },
      async revokeRefreshTokens(userID) { authRevoked.push(userID); },
      async deleteUser(userID) { authDeleted.push(userID); },
    }),
    environment: {
      MOJIDAS_ACCOUNT_DELETION_SECRET: '0123456789abcdef0123456789abcdef',
    },
    timestampProvider: () => 'server-time',
  });

  const add = (name, id, value) => {
    firestore.collection(`Mojidas/production/${name}`).documents.set(id, value);
  };
  add('users', 'user-1', { email: 'user@example.com' });
  add('emailVerificationChallenges', 'user-1', { uid: 'user-1' });
  add('creditGrants', 'grant-1', { userID: 'user-1' });
  add('creditGrants', 'grant-other', { userID: 'user-2' });
  add('creditReservations', 'reservation-1', { userID: 'user-1' });
  add('usageLedger', 'ledger-1', { userID: 'user-1' });
  add('dictionaryClients', 'client-1', { userID: 'user-1' });
  add('dictionaryAccounts', 'dictionary-1', { userID: 'user-1' });

  assert.strictEqual(await service.isEmailDeleted(' User@Example.com '), false);
  assert.deepStrictEqual(await service.deleteAccount({
    userID: 'user-1',
    email: 'User@Example.com',
  }), { deleted: true });
  assert.strictEqual(await service.isEmailDeleted('user@example.com'), true);
  assert.deepStrictEqual(authDeleted, ['user-1']);
  assert.deepStrictEqual(authDisabled, [['user-1', { disabled: true }]]);
  assert.deepStrictEqual(authRevoked, ['user-1']);
  assert.deepStrictEqual(firestore.recursivelyDeleted, ['dictionary-1']);
  assert.strictEqual(
    firestore.collection('Mojidas/production/creditGrants').documents.has('grant-other'),
    true
  );
  for (const [name, id] of [
    ['users', 'user-1'],
    ['emailVerificationChallenges', 'user-1'],
    ['creditGrants', 'grant-1'],
    ['creditReservations', 'reservation-1'],
    ['usageLedger', 'ledger-1'],
    ['dictionaryClients', 'client-1'],
    ['dictionaryAccounts', 'dictionary-1'],
  ]) {
    assert.strictEqual(
      firestore.collection(`Mojidas/production/${name}`).documents.has(id),
      false,
      `${name}/${id} should be deleted`
    );
  }

  const unconfigured = new MojidasAccountDeletionService({
    firestoreProvider: () => firestore,
    environment: {},
  });
  await assert.rejects(
    () => unconfigured.isEmailDeleted('user@example.com'),
    (error) => error instanceof AccountDeletionError
      && error.code === 'ACCOUNT_DELETION_NOT_CONFIGURED'
  );

  console.log('Mojidasアカウント削除: tombstoneとユーザーデータ削除のテストに成功しました。');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
