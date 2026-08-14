const assert = require('assert');

const {
  ACPApiKeyIssuer,
  ACPApiKeyIssuerError,
  normalizeExpiry,
} = require('../modules/acp/api_key_issuer');

async function main() {
  let captured;
  const issuer = new ACPApiKeyIssuer({
    serviceID: 'service-id',
    servicePassword: 'service-password',
    expiryMilliseconds: 120000,
    now: () => Date.parse('2026-08-14T01:00:00.000Z'),
    request: async (endpoint, body) => {
      captured = { endpoint, body };
      return '0123456789abcdef0123456789abcdef0123456789abcdef';
    },
  });

  const issued = await issuer.issue();
  assert.strictEqual(
    captured.endpoint,
    'https://acp-api.amivoice.com/issue_service_authorization'
  );
  const form = new URLSearchParams(captured.body);
  assert.strictEqual(form.get('sid'), 'service-id');
  assert.strictEqual(form.get('spw'), 'service-password');
  assert.strictEqual(form.get('epi'), '120000');
  assert.strictEqual(issued.appKey, '0123456789abcdef0123456789abcdef0123456789abcdef');
  assert.strictEqual(issued.expiresAt, '2026-08-14T01:02:00.000Z');

  const missingConfiguration = new ACPApiKeyIssuer({
    serviceID: '',
    servicePassword: '',
  });
  await assert.rejects(
    () => missingConfiguration.issue(),
    (error) => error instanceof ACPApiKeyIssuerError && error.code === 'ACP_NOT_CONFIGURED'
  );

  const invalidResponse = new ACPApiKeyIssuer({
    serviceID: 'service-id',
    servicePassword: 'service-password',
    request: async () => '<html>upstream error</html>',
  });
  await assert.rejects(
    () => invalidResponse.issue(),
    (error) => error instanceof ACPApiKeyIssuerError && error.code === 'ACP_INVALID_RESPONSE'
  );

  assert.strictEqual(normalizeExpiry(1), 30000);
  assert.strictEqual(normalizeExpiry(99999999), 600000);
  assert.strictEqual(normalizeExpiry('invalid'), 120000);

  console.log('ACP APIキー発行: 8件のテストに成功しました。');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
