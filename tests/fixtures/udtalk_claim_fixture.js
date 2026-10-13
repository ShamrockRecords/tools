const assert = require('assert');
const { WordAccountClaimStore } = require('../../modules/udtalk/word_account_claim_store');

const screenshot = {
  mimetype: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64'),
};
const validClaim = {
  accountName: 'テストアカウント', email: 'owner@example.com', emailConfirmation: 'owner@example.com',
  word1: '東京', reading1: 'とうきょう', word2: '京都', reading2: 'きょうと', word3: '大阪', reading3: 'おおさか',
};

function createFixture() {
  const records = new Map();
  const objects = new Map();
  const paths = [];
  const snapshot = id => ({ id, exists: records.has(id), data: () => records.get(id) });
  let queue = Promise.resolve();
  const db = {
    fail: false,
    collection(path) {
      paths.push(path);
      assert(/^UDTalk\/[A-Za-z0-9_-]+\/wordAccountClaims$/.test(path));
      let after;
      let limit;
      return {
        doc(id) { return { id, get: async () => snapshot(id) }; },
        orderBy(field, direction) { assert.equal(field, 'createdAt'); assert.equal(direction, 'desc'); return this; },
        startAfter(cursor) { after = cursor.id; return this; },
        limit(size) { limit = size; return this; },
        async get() {
          let rows = [...records.keys()].sort((a, b) => records.get(b).createdAt - records.get(a).createdAt || b.localeCompare(a));
          if (after) rows = rows.slice(rows.indexOf(after) + 1);
          return { docs: rows.slice(0, limit).map(snapshot) };
        },
      };
    },
    runTransaction(callback) {
      const task = queue.then(async () => {
        const writes = [];
        await callback({ get: ref => ref.get(), create: (ref, data) => writes.push([ref.id, data]) });
        if (db.fail) { db.fail = false; throw new Error('保存失敗'); }
        for (const [id, value] of writes) { assert(!records.has(id)); records.set(id, value); }
      });
      queue = task.catch(() => {});
      return task;
    },
  };
  const bucket = {
    name: 'private-fixture-bucket', fail: false,
    file(path) {
      return {
        async save(buffer, options) {
          if (bucket.fail) throw new Error('画像保存失敗');
          assert.equal(options.preconditionOpts.ifGenerationMatch, 0);
          assert.equal(options.metadata.cacheControl, 'private, no-store');
          if (objects.has(path)) throw Object.assign(new Error('作成済み'), { code: 412 });
          objects.set(path, { buffer, metadata: options.metadata });
        },
        getMetadata: async () => [objects.get(path).metadata],
        download: async () => [objects.get(path).buffer],
      };
    },
  };
  const store = new WordAccountClaimStore({ firestoreProvider: () => db, bucketProvider: () => bucket });
  return { store, db, bucket, records, objects, paths };
}

module.exports = { createFixture, validClaim, screenshot };
