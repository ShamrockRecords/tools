const assert = require('assert');

const {
  GoogleCloudTranslation,
  GoogleCloudTranslationError,
  buildTranslationBatches,
  compactTranslationText,
  decodeHTMLEntities,
  MAX_TEXTS_PER_REQUEST,
  MAX_CODE_POINTS_PER_REQUEST,
} = require('../modules/translation/google_cloud_translation');

function response(payload, statusCode = 200) {
  return { statusCode, body: JSON.stringify(payload) };
}

async function testTranslationAndBatching() {
  assert.strictEqual(
    compactTranslationText(' First sentence. \r\n\t \r\n Second sentence.  '),
    'First sentence.\nSecond sentence.'
  );
  assert.strictEqual(
    decodeHTMLEntities('&quot;Hello&#39;s &amp; &lt;tag&gt; &#x1F600;'),
    '"Hello\'s & <tag> 😀'
  );
  const requests = [];
  const translation = new GoogleCloudTranslation({
    apiKey: 'test-google-key',
    requester: async (request) => {
      requests.push(request);
      const payload = JSON.parse(request.body);
      return response({
        data: {
          translations: payload.q.map((text) => ({ translatedText: `translated:${text}` })),
        },
      });
    },
  });
  const texts = Array.from({ length: MAX_TEXTS_PER_REQUEST + 1 }, (_, index) => `text-${index}`);
  const translated = await translation.translate({
    texts,
    sourceLanguageCode: 'ja',
    targetLanguageCode: 'en',
  });

  assert.deepStrictEqual(translated, texts.map((text) => `translated:${text}`));
  assert.strictEqual(requests.length, 2);
  assert.strictEqual(JSON.parse(requests[0].body).q.length, MAX_TEXTS_PER_REQUEST);
  assert.strictEqual(JSON.parse(requests[1].body).q.length, 1);
  assert.strictEqual(requests[0].method, 'POST');
  assert.strictEqual(new URL(requests[0].url).pathname, '/language/translate/v2');
  assert.strictEqual(new URL(requests[0].url).searchParams.has('key'), false);
  assert.strictEqual(requests[0].headers['x-goog-api-key'], 'test-google-key');
  assert.strictEqual(requests[0].headers['Content-Type'], 'application/json; charset=utf-8');
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(JSON.parse(requests[0].body)).filter(([key]) => key !== 'q')),
    { source: 'ja', target: 'en', format: 'text' }
  );

  const codePointBatches = buildTranslationBatches([
    '😀'.repeat(3000),
    'あ'.repeat(2000),
    'tail',
  ]);
  assert.deepStrictEqual(codePointBatches.map((batch) => batch.length), [2, 1]);
}

async function testLanguageListCacheAndStaleFallback() {
  let currentTime = 1000;
  let shouldFail = false;
  const requests = [];
  const translation = new GoogleCloudTranslation({
    apiKey: 'test-google-key',
    now: () => currentTime,
    languageCacheTtlMilliseconds: 100,
    languageCacheStaleMilliseconds: 200,
    requester: async (request) => {
      requests.push(request);
      if (shouldFail) throw new Error('temporary provider failure');
      return response({
        data: {
          languages: [
            { language: 'en', name: '英語' },
            { language: 'zh-TW', name: '中国語（繁体）' },
          ],
        },
      });
    },
  });

  const first = await translation.listSupportedLanguages('ja');
  assert.deepStrictEqual(first, [
    { code: 'en', name: '英語' },
    { code: 'zh-TW', name: '中国語（繁体）' },
  ]);
  assert.strictEqual(requests[0].method, 'GET');
  const url = new URL(requests[0].url);
  assert.strictEqual(url.pathname, '/language/translate/v2/languages');
  assert.strictEqual(url.searchParams.get('target'), 'ja');
  assert.strictEqual(url.searchParams.get('model'), 'nmt');
  assert.strictEqual(url.searchParams.has('key'), false);
  assert.strictEqual(requests[0].headers['x-goog-api-key'], 'test-google-key');

  first[0].name = 'mutated';
  currentTime = 1050;
  assert.deepStrictEqual(await translation.listSupportedLanguages('ja'), [
    { code: 'en', name: '英語' },
    { code: 'zh-TW', name: '中国語（繁体）' },
  ]);
  assert.strictEqual(requests.length, 1);

  shouldFail = true;
  currentTime = 1150;
  assert.strictEqual((await translation.listSupportedLanguages('ja')).length, 2);
  assert.strictEqual(requests.length, 3);

  currentTime = 1301;
  await assert.rejects(
    () => translation.listSupportedLanguages('ja'),
    (error) => error instanceof GoogleCloudTranslationError
      && error.code === 'GOOGLE_TRANSLATION_REQUEST_FAILED'
  );
  assert.strictEqual(requests.length, 5);
}

async function testValidationAndProviderFailures() {
  let requestCount = 0;
  const translation = new GoogleCloudTranslation({
    apiKey: 'test-google-key',
    requester: async () => {
      requestCount += 1;
      return response({ data: { translations: [] } });
    },
  });

  await assert.rejects(
    () => translation.translate({
      texts: [''],
      sourceLanguageCode: 'ja',
      targetLanguageCode: 'en',
    }),
    (error) => error.code === 'INVALID_TRANSLATION_REQUEST'
  );
  await assert.rejects(
    () => translation.translate({
      texts: ['a'.repeat(MAX_CODE_POINTS_PER_REQUEST + 1)],
      sourceLanguageCode: 'ja',
      targetLanguageCode: 'en',
    }),
    (error) => error.code === 'TRANSLATION_TEXT_TOO_LONG'
  );
  assert.strictEqual(requestCount, 0);

  await assert.rejects(
    () => translation.translate({
      texts: ['hello'],
      sourceLanguageCode: 'en',
      targetLanguageCode: 'ja',
    }),
    (error) => error.code === 'GOOGLE_TRANSLATION_INVALID_RESPONSE'
  );

  const emptyTranslation = new GoogleCloudTranslation({
    apiKey: 'test-google-key',
    requester: async () => response({
      data: { translations: [{ translatedText: '   ' }] },
    }),
  });
  await assert.rejects(
    () => emptyTranslation.translate({
      texts: ['hello'],
      sourceLanguageCode: 'en',
      targetLanguageCode: 'ja',
    }),
    (error) => error.code === 'GOOGLE_TRANSLATION_INVALID_RESPONSE'
  );

  const entityWhitespaceTranslation = new GoogleCloudTranslation({
    apiKey: 'test-google-key',
    requester: async () => response({
      data: { translations: [{ translatedText: '&#32;' }] },
    }),
  });
  await assert.rejects(
    () => entityWhitespaceTranslation.translate({
      texts: ['hello'],
      sourceLanguageCode: 'en',
      targetLanguageCode: 'ja',
    }),
    (error) => error.code === 'GOOGLE_TRANSLATION_INVALID_RESPONSE'
  );

  const invalidUtf8Translation = new GoogleCloudTranslation({
    apiKey: 'test-google-key',
    requester: async () => ({
      statusCode: 200,
      body: Buffer.from([0xc3, 0x28]),
    }),
  });
  await assert.rejects(
    () => invalidUtf8Translation.listSupportedLanguages('ja'),
    (error) => error.code === 'GOOGLE_TRANSLATION_INVALID_RESPONSE'
  );

  const invalidLanguages = new GoogleCloudTranslation({
    apiKey: 'test-google-key',
    requester: async () => response({
      data: {
        languages: [
          { language: 'en', name: '英語' },
          { language: 'EN', name: 'English' },
        ],
      },
    }),
  });
  await assert.rejects(
    () => invalidLanguages.listSupportedLanguages('ja'),
    (error) => error.code === 'GOOGLE_TRANSLATION_INVALID_RESPONSE'
  );

  const failedStatus = new GoogleCloudTranslation({
    apiKey: 'test-google-key',
    requester: async () => response({ error: { message: 'denied' } }, 403),
  });
  await assert.rejects(
    () => failedStatus.listSupportedLanguages('ja'),
    (error) => error.code === 'GOOGLE_TRANSLATION_REQUEST_FAILED' && error.statusCode === 403
  );

  let rateLimitedCalls = 0;
  const rateLimited = new GoogleCloudTranslation({
    apiKey: 'test-google-key',
    requester: async () => {
      rateLimitedCalls += 1;
      return response({ error: { message: 'rate limited' } }, 429);
    },
  });
  await assert.rejects(
    () => rateLimited.listSupportedLanguages('ja'),
    (error) => error.code === 'GOOGLE_TRANSLATION_RATE_LIMITED'
  );
  assert.strictEqual(rateLimitedCalls, 2);

  let retryRequestCount = 0;
  const retrying = new GoogleCloudTranslation({
    apiKey: 'test-google-key',
    requester: async () => {
      retryRequestCount += 1;
      return retryRequestCount === 1
        ? response({ error: { message: 'temporary' } }, 500)
        : response({ data: { languages: [{ language: 'en', name: 'English' }] } });
    },
  });
  assert.strictEqual((await retrying.listSupportedLanguages('en')).length, 1);
  assert.strictEqual(retryRequestCount, 2);

  const oversized = new GoogleCloudTranslation({
    apiKey: 'test-google-key',
    maxResponseBytes: 10,
    requester: async () => ({ statusCode: 200, body: '12345678901' }),
  });
  await assert.rejects(
    () => oversized.listSupportedLanguages('ja'),
    (error) => error.code === 'GOOGLE_TRANSLATION_RESPONSE_TOO_LARGE'
  );

  let timeoutRequestCount = 0;
  const timeout = new GoogleCloudTranslation({
    apiKey: 'test-google-key',
    requester: async () => {
      timeoutRequestCount += 1;
      throw new GoogleCloudTranslationError(
        'GOOGLE_TRANSLATION_TIMEOUT',
        'timeout'
      );
    },
  });
  await assert.rejects(
    () => timeout.listSupportedLanguages('ja'),
    (error) => error.code === 'GOOGLE_TRANSLATION_TIMEOUT'
  );
  assert.strictEqual(timeoutRequestCount, 2);

  let missingKeyRequestCount = 0;
  const missingKey = new GoogleCloudTranslation({
    apiKey: '',
    requester: async () => {
      missingKeyRequestCount += 1;
      return response({});
    },
  });
  await assert.rejects(
    () => missingKey.listSupportedLanguages('ja'),
    (error) => error.code === 'GOOGLE_TRANSLATION_NOT_CONFIGURED'
  );
  assert.strictEqual(missingKeyRequestCount, 0);
}

async function main() {
  await testTranslationAndBatching();
  await testLanguageListCacheAndStaleFallback();
  await testValidationAndProviderFailures();
  console.log('Google Cloud Translation tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
