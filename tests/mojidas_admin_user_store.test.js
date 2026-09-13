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
        pageToken: 'next-token',
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

  const result = await store.listUsers({ pageToken: 'current-token', pageSize: 20 });
  assert.deepStrictEqual(calls[0], ['list', 20, 'current-token']);
  assert.strictEqual(result.nextPageToken, 'next-token');
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
  assert.strictEqual(failed.nextPageToken, 'next-token');

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
