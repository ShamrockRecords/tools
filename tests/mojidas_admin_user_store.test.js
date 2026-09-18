const assert = require('assert');

const {
  INVITED_UNLIMITED_CLAIM,
  isInvitedUnlimited,
} = require('../modules/auth/mojidas_access_policy');
const {
  MojidasAdminUserStore,
} = require('../modules/auth/mojidas_admin_user_store');

async function main() {
  const calls = [];
  const auth = {
    async listUsers(limit, pageToken) {
      calls.push(['list', limit, pageToken]);
      return {
        users: [{
          uid: 'user-1',
          email: 'user@example.com',
          emailVerified: true,
          disabled: false,
          customClaims: { [INVITED_UNLIMITED_CLAIM]: true },
          metadata: {
            creationTime: '2026-08-01T00:00:00.000Z',
            lastSignInTime: '2026-08-22T00:00:00.000Z',
          },
        }],
        pageToken: null,
      };
    },
    async getUser(uid) {
      calls.push(['get', uid]);
      return {
        uid,
        customClaims: { existingRole: 'reviewer' },
      };
    },
    async setCustomUserClaims(uid, claims) {
      calls.push(['set', uid, claims]);
    },
  };
  let clientData = { appClients: {
    macos: { version: '0.24.0', lastSeenAt: { toDate: () => new Date('2026-09-13T00:00:00Z') } },
    windows: { version: '1.2.3.4', lastSeenAt: '2026-09-12T00:00:00Z' },
  } };
  let failClients = false;
  const firestoreProvider = () => ({ collection(path) {
    assert.strictEqual(path, 'Mojidas/production/users');
    return { doc(uid) { assert.strictEqual(uid, 'user-1'); return { async get() {
      if (failClients) throw new Error('fixture read failure');
      return { exists: clientData !== null, data: () => clientData };
    } }; } };
  } });
  const store = new MojidasAdminUserStore({ firestoreProvider, authProvider: () => auth, credits: { async getBalance() { return { availableMilliseconds: 0, grants: [] }; } } });

  const result = await store.listUsers({ pageSize: 20 });
  assert.deepStrictEqual(calls[0], ['list', 1000, undefined]);
  assert.strictEqual(result.nextPageToken, null);
  assert.strictEqual(result.users[0].invitedUnlimited, true);
  assert.strictEqual(isInvitedUnlimited({ customClaims: {} }), false);
  assert.deepStrictEqual(result.users[0].appClients, {
    macos: { version: '0.24.0', lastSeenAt: '2026-09-13T00:00:00.000Z' },
    windows: { version: '1.2.3.4', lastSeenAt: '2026-09-12T00:00:00.000Z' },
  });
  clientData = null;
  assert.deepStrictEqual(await store.getAppClients('user-1'), { macos: null, windows: null });
  clientData = { appClients: { macos: { version: '<script>bad</script>' }, windows: { version: '1.2.3.4', lastSeenAt: 'invalid' } } };
  assert.deepStrictEqual(await store.getAppClients('user-1'), { macos: null, windows: { version: '1.2.3.4', lastSeenAt: null } });
  failClients = true;
  const failed = await store.listUsers();
  assert.strictEqual(failed.users[0].appClients, null);
  assert.strictEqual(failed.users[0].email, 'user@example.com');
  assert.strictEqual(failed.nextPageToken, null);
  store.partners = { async entitlement(user) {
    assert.strictEqual(user.uid, 'user-1');
    assert.strictEqual(user.emailVerified, true);
    return { domain: 'example.com', partnerID: 'partner-1' };
  } };
  assert.strictEqual((await store.listUsers()).users[0].isCorporate, true);
  store.partners.entitlement = async () => null;
  assert.strictEqual((await store.listUsers()).users[0].isCorporate, false);
  store.partners.entitlement = async () => { throw new Error('fixture unavailable'); };
  assert.strictEqual((await store.listUsers()).users[0].isCorporate, null);

  // Authの別ページにいる最新ユーザーも先頭へ。残高の取得は表示対象だけ。
  const fixtures = [
    { uid: 'old', metadata: { creationTime: '2025-01-01' } },
    { uid: 'unknown', metadata: {} },
    { uid: 'new', metadata: { creationTime: '2026-09-15' } },
    { uid: 'middle', metadata: { creationTime: '2026-01-01' } },
  ];
  const snapshot = JSON.stringify(fixtures);
  const sorted = new MojidasAdminUserStore({ authProvider: () => ({
    async listUsers(limit, token) {
      assert.strictEqual(limit, 1000);
      return token ? { users: fixtures.slice(2) } : { users: fixtures.slice(0, 2), pageToken: 'auth-next' };
    },
  }) });
  const loaded = [];
  let statisticsReads = 0;
  sorted.firestoreProvider = () => ({ collection: () => ({ select(field) {
    assert.strictEqual(field, 'appClients');
    return { async get() {
      statisticsReads++;
      return { docs: [
        { id: 'old', data: () => ({ appClients: { macos: { version: '1.2.3' } } }) },
        { id: 'new', data: () => ({ appClients: { windows: { version: '1.2.3.4' } } }) },
      ] };
    } };
  } }) });
  sorted.getUserCredit = async user => { loaded.push(user.uid); return null; };
  sorted.getAppClients = async () => ({});
  const first = await sorted.listUsers({ pageSize: 2 });
  assert.strictEqual(statisticsReads, 1);
  assert.deepStrictEqual(first.statistics.platforms.map(item => item.count), [1, 1, 0, 2]);
  assert.deepStrictEqual(first.users.map(user => user.uid), ['new', 'middle']);
  assert.deepStrictEqual(loaded, ['new', 'middle']);
  const second = await sorted.listUsers({ pageSize: 2, pageToken: first.nextPageToken });
  assert.deepStrictEqual(second.statistics, first.statistics);
  assert.deepStrictEqual(second.users.map(user => user.uid), ['old', 'unknown']);
  assert.strictEqual(second.nextPageToken, null);
  assert.strictEqual(first.totalUsers, 4);
  assert.strictEqual(first.totalPages, 2);
  assert.strictEqual(first.startIndex, 1);
  assert.strictEqual(first.endIndex, 2);
  const direct = await sorted.listUsers({ pageSize: 2, page: 2 });
  assert.deepStrictEqual(direct.users.map(user => user.uid), ['old', 'unknown']);
  assert.strictEqual(direct.startIndex, 3);
  assert.strictEqual(direct.endIndex, 4);
  assert.strictEqual((await sorted.listUsers({ pageSize: 2, page: 999 })).page, 2);
  assert.strictEqual((await sorted.listUsers({ pageSize: 2, page: -1 })).page, 1);
  const emptyStore = new MojidasAdminUserStore({ authProvider: () => ({ listUsers: async () => ({ users: [] }) }) });
  const emptyPage = await emptyStore.listUsers({ page: 3 });
  assert.deepStrictEqual([emptyPage.page, emptyPage.totalPages, emptyPage.totalUsers, emptyPage.startIndex, emptyPage.endIndex], [1, 1, 0, 0, 0]);
  assert.strictEqual(JSON.stringify(fixtures), snapshot);

  await store.setInvitedUnlimited({ uid: 'user-1', enabled: true });
  assert.deepStrictEqual(calls.at(-1), [
    'set',
    'user-1',
    { existingRole: 'reviewer', [INVITED_UNLIMITED_CLAIM]: true },
  ]);

  auth.getUser = async (uid) => ({
    uid,
    customClaims: { existingRole: 'reviewer', [INVITED_UNLIMITED_CLAIM]: true },
  });
  await store.setInvitedUnlimited({ uid: 'user-1', enabled: false });
  assert.deepStrictEqual(calls.at(-1), ['set', 'user-1', { existingRole: 'reviewer' }]);

  console.log('mojidas admin user store tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
