const crypto = require('crypto');

const HASH_ALGORITHM = 'scrypt';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

class AdminAuthConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdminAuthConfigurationError';
    this.code = 'ADMIN_AUTH_NOT_CONFIGURED';
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function createAdminPasswordHash(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('管理者パスワードは8文字以上にしてください。');
  }

  const salt = crypto.randomBytes(SALT_LENGTH);
  const derivedKey = crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEMORY,
  });

  return [
    HASH_ALGORITHM,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derivedKey.toString('base64'),
  ].join('$');
}

function parsePasswordHash(encodedHash) {
  const parts = String(encodedHash || '').split('$');
  if (parts.length !== 6 || parts[0] !== HASH_ALGORITHM) {
    throw new AdminAuthConfigurationError('ADMIN_PASSWORD_HASHの形式が正しくありません。');
  }

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64');
  const expectedKey = Buffer.from(parts[5], 'base64');

  if (
    N !== SCRYPT_N ||
    r !== SCRYPT_R ||
    p !== SCRYPT_P ||
    salt.length !== SALT_LENGTH ||
    expectedKey.length !== KEY_LENGTH
  ) {
    throw new AdminAuthConfigurationError('ADMIN_PASSWORD_HASHのパラメータが正しくありません。');
  }

  return { N, r, p, salt, expectedKey };
}

function verifyPassword(password, encodedHash) {
  const { N, r, p, salt, expectedKey } = parsePasswordHash(encodedHash);
  const actualKey = crypto.scryptSync(String(password || ''), salt, expectedKey.length, {
    N,
    r,
    p,
    maxmem: MAX_MEMORY,
  });

  return crypto.timingSafeEqual(actualKey, expectedKey);
}

function loadAdminCredentials(env = process.env) {
  const email = normalizeEmail(env.ADMIN_EMAIL);
  const passwordHash = String(env.ADMIN_PASSWORD_HASH || '').trim();

  if (!email || !passwordHash) {
    throw new AdminAuthConfigurationError(
      'ADMIN_EMAILとADMIN_PASSWORD_HASHを設定してください。'
    );
  }

  // Validate once when the verifier is built, rather than failing only after a login attempt.
  parsePasswordHash(passwordHash);
  return { email, passwordHash };
}

function createAdminCredentialVerifier(env = process.env) {
  const credentials = loadAdminCredentials(env);

  return async function verifyAdminCredentials(email, password) {
    // Always run the password KDF, even when the email differs, to reduce account probing signals.
    const passwordMatches = verifyPassword(password, credentials.passwordHash);
    const emailBuffer = Buffer.from(normalizeEmail(email));
    const expectedEmailBuffer = Buffer.from(credentials.email);
    const emailMatches =
      emailBuffer.length === expectedEmailBuffer.length &&
      crypto.timingSafeEqual(emailBuffer, expectedEmailBuffer);

    return passwordMatches && emailMatches
      ? { email: credentials.email }
      : null;
  };
}

module.exports = {
  AdminAuthConfigurationError,
  createAdminCredentialVerifier,
  createAdminPasswordHash,
  loadAdminCredentials,
  normalizeEmail,
  verifyPassword,
};
