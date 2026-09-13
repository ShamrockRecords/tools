const assert = require('assert');
const { MojidasUserStore } = require('../modules/auth/mojidas_user_store');

module.exports = async function () {
  const writes = [];
  const store = new MojidasUserStore({
    timestamp: () => 'server-time',
    firestoreProvider: () => ({ collection: () => ({ doc: uid => ({
      set: async (data, options) => writes.push({ uid, data, options }),
    }) }) }),
  });
  await store.recordClientInfo('account-a', 'macos', '0.24.0');
  await store.recordClientInfo('account-a', 'windows', '1.2.3.4');
  for (const [platform, version] of [['unknown', '1.2.3'], ['macos', '1.2'], ['windows', '1.2.3'], ['macos', undefined]]) {
    await store.recordClientInfo('account-a', platform, version);
  }
  assert.strictEqual(writes.length, 2);
  assert.deepStrictEqual(writes[0], { uid: 'account-a', options: { merge: true },
    data: { appClients: { macos: { version: '0.24.0', lastSeenAt: 'server-time' } } } });
  assert.deepStrictEqual(writes[1].data, { appClients: { windows: { version: '1.2.3.4', lastSeenAt: 'server-time' } } });
  console.log('client version store: OS別merge・不正値無視・アカウント指定を確認');
};
