const assert = require('assert');
const {
  AdminAuthConfigurationError,
  createAdminCredentialVerifier,
  createAdminPasswordHash,
  loadAdminCredentials,
  verifyPassword,
} = require('../modules/auth/admin_credentials');

async function main() {
  const password = 'correct horse battery staple';
  const passwordHash = createAdminPasswordHash(password);

  assert.strictEqual(verifyPassword(password, passwordHash), true);
  assert.strictEqual(verifyPassword('incorrect password', passwordHash), false);
  assert.strictEqual(verifyPassword('12345678', createAdminPasswordHash('12345678')), true);

  const verify = createAdminCredentialVerifier({
    ADMIN_EMAIL: 'Admin@Example.com ',
    ADMIN_PASSWORD_HASH: passwordHash,
  });

  assert.deepStrictEqual(
    await verify('admin@example.com', password),
    { email: 'admin@example.com' }
  );
  assert.strictEqual(await verify('other@example.com', password), null);
  assert.strictEqual(await verify('admin@example.com', 'incorrect password'), null);

  assert.throws(
    () => loadAdminCredentials({}),
    (error) => error instanceof AdminAuthConfigurationError
  );
  assert.throws(() => createAdminPasswordHash('1234567'));

  console.log('admin_credentials tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
