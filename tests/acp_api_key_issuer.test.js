const assert = require('assert');
const fs = require('fs');
const { ACPApiKeyIssuer, ACPApiKeyIssuerError } = require('../modules/acp/api_key_issuer');

async function main() {
  const fixedKey = 'fixture-key-0123456789abcdef0123456789abcdef';
  const original = process.env.ACP_LONG_TERM_APPKEY;
  try {
    process.env.ACP_LONG_TERM_APPKEY = fixedKey;
    const issuer = new ACPApiKeyIssuer();
    for (const options of [undefined, { expiryMilliseconds: 600000 }, undefined]) {
      assert.deepStrictEqual(await issuer.issue(options), { appKey: fixedKey, expiresAt: null });
    }
    process.env.ACP_LONG_TERM_APPKEY = fixedKey + '-rotated';
    assert.strictEqual((await new ACPApiKeyIssuer().issue()).appKey, fixedKey + '-rotated');
    assert.strictEqual((await issuer.issue()).appKey, fixedKey);
    for (const invalid of ['', '   ', 'invalid-secret', '<html>' + fixedKey, fixedKey + '\n' + fixedKey, 'x'.repeat(4097)]) {
      const missing = new ACPApiKeyIssuer({
        longTermAppKey: invalid,
        serviceID: 'unused-id',
        servicePassword: 'unused-password',
        request: async () => { throw new Error('旧発行へ戻ってはいけない'); },
      });
      await assert.rejects(() => missing.issue(), error =>
        error instanceof ACPApiKeyIssuerError && error.code === 'ACP_NOT_CONFIGURED'
        && !error.message.includes('unused-password'));
    }
    delete process.env.ACP_LONG_TERM_APPKEY;
    await assert.rejects(() => new ACPApiKeyIssuer().issue(), error => error.code === 'ACP_NOT_CONFIGURED');
    const source = fs.readFileSync(require.resolve('../modules/acp/api_key_issuer'), 'utf8');
    for (const removed of ['ACP_SERVICE_ID', 'ACP_SERVICE_PASSWORD', 'issue_service_authorization', 'https', 'normalizeExpiry']) {
      assert.ok(!source.includes(removed), '旧キー発行処理を再導入しない: ' + removed);
    }
  } finally {
    if (original === undefined) delete process.env.ACP_LONG_TERM_APPKEY;
    else process.env.ACP_LONG_TERM_APPKEY = original;
  }
  console.log('長期APPKEY専用: 同一応答・交換・未設定・不正設定・旧発行削除の検証成功');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
