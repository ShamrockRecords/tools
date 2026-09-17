const assert = require('assert');

const {
  DEFAULT_MACOS_VERSION,
  DEFAULT_WINDOWS_VERSION,
  MojidasVersionStore,
  MojidasVersionStoreError,
  normalizeVersion,
} = require('../modules/mojidas_version_store');

function createFirestore(initialData) {
  let data = initialData;
  const writes = [];
  const document = {
    async get() {
      return {
        exists: data !== undefined,
        data: () => data,
      };
    },
    async set(value, options) {
      assert.strictEqual(options.merge, true);
      data = { ...data, ...value };
      writes.push(value);
    },
  };
  return {
    writes,
    collection(path) {
      assert.strictEqual(path, 'Mojidas/production/configuration');
      return {
        doc(id) {
          assert.strictEqual(id, 'appVersions');
          return document;
        },
      };
    },
  };
}

async function main() {
  assert.strictEqual(normalizeVersion(' 1.2.3 ', 3, 'Mac版'), '1.2.3');
  assert.strictEqual(normalizeVersion('1.2.3.4', 4, 'Windows版'), '1.2.3.4');
  assert.throws(
    () => normalizeVersion('1.2', 3, 'Mac版'),
    (error) => error instanceof MojidasVersionStoreError
      && error.code === 'INVALID_VERSION'
  );
  assert.throws(() => normalizeVersion('1.2.beta.4', 4, 'Windows版'));
  assert.throws(() => normalizeVersion('1.2.3.65536', 4, 'Windows版'));
  assert.throws(() => normalizeVersion('01.2.3', 3, 'Mac版'));

  const emptyFirestore = createFirestore(undefined);
  const emptyStore = new MojidasVersionStore({
    firestoreProvider: () => emptyFirestore,
  });
  assert.deepStrictEqual(await emptyStore.getVersions(), {
    schemaVersion: 1,
    macOSVersion: DEFAULT_MACOS_VERSION,
    windowsVersion: DEFAULT_WINDOWS_VERSION,
    macOSMessage: '',
    windowsMessage: '',
    updatedAt: null,
  });

  const now = new Date('2026-08-30T12:00:00.000Z');
  const firestore = createFirestore({
    macOSVersion: '1.2.3',
    windowsVersion: '2.3.4.5',
    updatedAt: now,
  });
  const store = new MojidasVersionStore({
    firestoreProvider: () => firestore,
    now: () => now,
  });
  assert.deepStrictEqual(await store.getVersions(), {
    schemaVersion: 1,
    macOSVersion: '1.2.3',
    windowsVersion: '2.3.4.5',
    macOSMessage: '',
    windowsMessage: '',
    updatedAt: now,
  });

  const saved = await store.setVersions({
    macOSVersion: ' 3.4.5 ',
    windowsVersion: ' 6.7.8.9 ',
  });
  assert.deepStrictEqual(saved, {
    schemaVersion: 1,
    macOSVersion: '3.4.5',
    windowsVersion: '6.7.8.9',
    macOSMessage: '',
    windowsMessage: '',
    updatedAt: now,
  });
  assert.deepStrictEqual(firestore.writes, [{
    macOSVersion: '3.4.5',
    windowsVersion: '6.7.8.9',
    updatedAt: now,
  }]);

  const versions = { macOSVersion: '3.4.5', windowsVersion: '6.7.8.9' };
  await store.setVersions({ ...versions, macOSMessage: ' 改善しました。\n不具合修正 ', windowsMessage: 'Windowsの改善' });
  const persisted = await new MojidasVersionStore({ firestoreProvider: () => firestore }).getVersions();
  assert.strictEqual(persisted.macOSMessage, '改善しました。\n不具合修正');
  assert.strictEqual(persisted.windowsMessage, 'Windowsの改善');
  await store.setVersions(versions);
  assert.deepStrictEqual(await store.getVersions(), persisted);
  for (const invalid of [{ macOSMessage: 'x'.repeat(2001) }, { windowsMessage: null }, { macOSVersion: 'invalid' }]) {
    const writeCount = firestore.writes.length;
    await assert.rejects(store.setVersions({ ...versions, ...invalid }), MojidasVersionStoreError);
    assert.strictEqual(firestore.writes.length, writeCount);
    assert.deepStrictEqual(await store.getVersions(), persisted);
  }
  await store.setVersions({ ...versions, macOSMessage: '  \n ' });
  assert.strictEqual((await store.getVersions()).macOSMessage, '');
  assert.strictEqual((await store.getVersions()).windowsMessage, persisted.windowsMessage);

  const ejs = require('ejs');
  const html = await ejs.renderFile(require('path').join(__dirname, '../views/admin/mojidas-versions.ejs'), {
    user: {}, form: { ...versions, macOSMessage: '</textarea><script>alert(1)</script>' },
    updatedAt: null, csrfToken: 'test', flash: null,
  });
  assert(html.includes('name="macOSMessage"'));
  assert(html.includes('name="windowsMessage"'));
  assert(!html.includes('<script>alert(1)</script>'));
  console.log('Mojidas version store tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
