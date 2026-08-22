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
  const store = new MojidasAdminUserStore({ authProvider: () => auth });

  const result = await store.listUsers({ pageToken: 'current-token', pageSize: 20 });
  assert.deepStrictEqual(calls[0], ['list', 20, 'current-token']);
  assert.strictEqual(result.nextPageToken, 'next-token');
  assert.strictEqual(result.users[0].invitedUnlimited, true);
  assert.strictEqual(isInvitedUnlimited({ customClaims: {} }), false);

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
