const assert = require('assert');
const http = require('http');
const express = require('express');

const { createMojidasRouter } = require('../routes/api/mojidas');

function request(server, method, path, body, token) {
  const address = server.address();
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method,
      path,
      headers: {
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: responseBody ? JSON.parse(responseBody) : null,
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForFormalTranslation(server, response, token) {
  if (response.status !== 202) return response;
  assert.strictEqual(response.body.status, 'processing');
  assert.ok(response.body.jobID);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const polled = await request(
      server,
      'GET',
      `/api/mojidas/translation/formal/jobs/${encodeURIComponent(response.body.jobID)}`,
      undefined,
      token
    );
    if (polled.status !== 202) return polled;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('formal translation job did not complete');
}

async function main() {
  const calls = [];
  const creditCalls = [];
  const chargedKeys = new Set();
  let chargedTotal = 0;
  let nextCreditError = null;
  let nextError = null;
  const translationService = {
    async listSupportedLanguages(displayLanguage) {
      calls.push(['languages', displayLanguage]);
      if (nextError) throw nextError;
      return {
        schemaVersion: 1,
        provider: 'googleCloudTranslationBasicV2',
        displayLanguage,
        languages: [{ code: 'en', name: '英語' }],
      };
    },
    async translateRealtime(value) {
      calls.push(['realtime', value]);
      if (nextError) throw nextError;
      return { translatedText: 'Hello', sourceTranscriptID: value.request.sourceTranscriptID };
    },
    async estimateFormal(value) {
      calls.push(['formal-estimate', value]);
      if (nextError) throw nextError;
      return {
        sourceSessionID: value.request.sourceSessionID,
        targetLanguageCode: value.request.targetLanguageCode,
        targetMilliseconds: 2400,
        billingRate: 0.5,
        billableMilliseconds: 1200,
        totalBlockCount: 3,
        translationBlockCount: 2,
        reusedBlockCount: 1,
        passThroughBlockCount: 0,
        noTranslationRequired: false,
      };
    },
    async translateFormal(value) {
      calls.push(['formal', value]);
      if (nextError) throw nextError;
      return {
        sourceSessionID: value.request.sourceSessionID,
        targetLanguageCode: value.request.targetLanguageCode,
        blocks: [],
        billableMilliseconds: 1200,
        idempotencyKey: value.request.idempotencyKey,
        requestFingerprint: 'a'.repeat(64),
      };
    },
  };
  const creditStore = {
    async consumeTranslation(value) {
      creditCalls.push(value);
      if (nextCreditError) throw nextCreditError;
      const key = `${value.userID}:${value.idempotencyKey}`;
      const alreadyConsumed = chargedKeys.has(key);
      if (!alreadyConsumed) {
        chargedKeys.add(key);
        chargedTotal += value.milliseconds;
      }
      return {
        billableMilliseconds: value.milliseconds,
        chargedMilliseconds: value.isUnlimited ? 0 : value.milliseconds,
        isUnlimited: value.isUnlimited,
        alreadyConsumed,
      };
    },
  };
  const authClient = {
    async verifyAccessToken(token) {
      if (!['user-one-token', 'user-two-token'].includes(token)) {
        const error = new Error('invalid token');
        error.code = 'ID_TOKEN_REVOKED';
        throw error;
      }
      return {
        uid: token === 'user-one-token' ? 'user-1' : 'user-2',
        email: 'user@example.com',
        emailVerified: true,
        metadata: { creationTime: '2026-08-01T00:00:00.000Z' },
      };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/mojidas', createMojidasRouter({
    authClient,
    creditStore,
    translationService,
  }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });

  try {
    let response = await request(
      server,
      'GET',
      '/api/mojidas/translation/languages?displayLanguage=ja'
    );
    assert.strictEqual(response.status, 401);

    response = await request(
      server,
      'GET',
      '/api/mojidas/translation/languages?displayLanguage=ja',
      undefined,
      'user-one-token'
    );
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.languages[0].code, 'en');
    assert.match(response.headers['cache-control'], /^private/);
    assert.deepStrictEqual(calls.at(-1), ['languages', 'ja']);

    const realtimeBody = {
      sourceTranscriptID: 'transcript-1',
      sourceLanguageCode: 'ja',
      targetLanguageCode: 'en',
      text: 'こんにちは',
      sourceTextFingerprint: `sha256-nfc-v1:${'0'.repeat(64)}`,
      idempotencyKey: 'request-1',
    };
    response = await request(
      server,
      'POST',
      '/api/mojidas/translation/realtime',
      realtimeBody,
      'user-one-token'
    );
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.translatedText, 'Hello');
    assert.strictEqual(calls.at(-1)[1].userID, 'user-1');
    assert.deepStrictEqual(calls.at(-1)[1].request, realtimeBody);

    const formalBody = {
      sourceSessionID: 'session-1',
      targetLanguageCode: 'en',
      segments: [],
      idempotencyKey: 'formal-1',
    };
    const estimateBody = {
      sourceSessionID: formalBody.sourceSessionID,
      targetLanguageCode: formalBody.targetLanguageCode,
      segments: formalBody.segments,
      reusableBlocks: [],
    };
    response = await request(
      server,
      'POST',
      '/api/mojidas/translation/formal/estimate',
      estimateBody,
      'user-one-token'
    );
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.targetMilliseconds, 2400);
    assert.strictEqual(response.body.billingRate, 0.5);
    assert.strictEqual(response.body.billableMilliseconds, 1200);
    assert.strictEqual(creditCalls.length, 0);
    assert.deepStrictEqual(calls.at(-1), [
      'formal-estimate',
      { userID: 'user-1', request: estimateBody },
    ]);

    response = await request(
      server,
      'POST',
      '/api/mojidas/translation/formal',
      formalBody,
      'user-one-token'
    );
    response = await waitForFormalTranslation(server, response, 'user-one-token');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.sourceSessionID, 'session-1');
    assert.strictEqual(response.body.billableMilliseconds, 1200);
    assert.strictEqual(response.body.chargedMilliseconds, 1200);
    assert.strictEqual(response.body.isUnlimited, false);
    assert.strictEqual(calls.at(-1)[1].userID, 'user-1');
    assert.strictEqual(creditCalls.at(-1).idempotencyKey, 'formal-1');
    assert.strictEqual(creditCalls.at(-1).requestFingerprint, 'a'.repeat(64));
    assert.strictEqual(response.body.requestFingerprint, undefined);
    assert.strictEqual(creditCalls.at(-1).milliseconds, 1200);
    assert.strictEqual(chargedTotal, 1200);

    response = await request(
      server,
      'POST',
      '/api/mojidas/translation/formal',
      formalBody,
      'user-one-token'
    );
    assert.strictEqual(response.status, 200);
    assert.strictEqual(chargedTotal, 1200);

    nextCreditError = Object.assign(new Error('insufficient'), {
      code: 'INSUFFICIENT_CREDIT',
      details: { requiredMilliseconds: 1200, availableMilliseconds: 100 },
    });
    response = await request(
      server,
      'POST',
      '/api/mojidas/translation/formal',
      { ...formalBody, idempotencyKey: 'formal-insufficient' },
      'user-one-token'
    );
    response = await waitForFormalTranslation(server, response, 'user-one-token');
    assert.strictEqual(response.status, 409);
    assert.strictEqual(response.body.error.code, 'INSUFFICIENT_CREDIT');
    nextCreditError = null;

    nextCreditError = Object.assign(new Error('invalid translation usage'), {
      code: 'INVALID_TRANSLATION_USAGE',
    });
    response = await request(
      server,
      'POST',
      '/api/mojidas/translation/formal',
      { ...formalBody, idempotencyKey: 'formal-invalid-usage' },
      'user-one-token'
    );
    response = await waitForFormalTranslation(server, response, 'user-one-token');
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.error.code, 'INVALID_TRANSLATION_USAGE');

    nextCreditError = Object.assign(new Error('idempotency conflict'), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    response = await request(
      server,
      'POST',
      '/api/mojidas/translation/formal',
      { ...formalBody, idempotencyKey: 'formal-conflicting-key' },
      'user-one-token'
    );
    response = await waitForFormalTranslation(server, response, 'user-one-token');
    assert.strictEqual(response.status, 409);
    assert.strictEqual(response.body.error.code, 'IDEMPOTENCY_CONFLICT');
    nextCreditError = null;

    nextError = Object.assign(new Error('not configured'), {
      code: 'GOOGLE_TRANSLATION_NOT_CONFIGURED',
    });
    response = await request(
      server,
      'GET',
      '/api/mojidas/translation/languages',
      undefined,
      'user-one-token'
    );
    assert.strictEqual(response.status, 503);
    assert.strictEqual(response.body.error.code, 'GOOGLE_TRANSLATION_NOT_CONFIGURED');
    nextError = null;

    // 最初の1回を含め、同じユーザーの120回までは許可される。
    for (let index = 1; index < 120; index += 1) {
      response = await request(
        server,
        'POST',
        '/api/mojidas/translation/realtime',
        realtimeBody,
        'user-one-token'
      );
      assert.strictEqual(response.status, 200);
    }
    response = await request(
      server,
      'POST',
      '/api/mojidas/translation/realtime',
      realtimeBody,
      'user-one-token'
    );
    assert.strictEqual(response.status, 429);
    assert.strictEqual(response.body.error.code, 'RATE_LIMITED');

    // レート制限キーはIPだけでなく認証ユーザーごとに分離される。
    response = await request(
      server,
      'POST',
      '/api/mojidas/translation/realtime',
      realtimeBody,
      'user-two-token'
    );
    assert.strictEqual(response.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('Mojidas translation API tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
