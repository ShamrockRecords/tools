const assert = require('assert');

const {
  canonicalizeTranslationLanguages,
  MojidasTranslationService,
  areEquivalentLanguages,
  calculateBillableMilliseconds,
  googleTranslationLanguageCode,
  textFingerprint,
} = require('../modules/translation/mojidas_translation_service');

function sourceSegment(id, overrides = {}) {
  const value = {
    id,
    inputID: 'input-1',
    recordingID: 'recording-1',
    recognitionRunID: 'run-1',
    sourceLanguageCode: 'ja',
    startMilliseconds: 0,
    endMilliseconds: 1000,
    text: `${id}の本文`,
    label: '話者1',
    colorHex: '336699',
    recognitionStartedAt: '2026-09-01T01:00:00.000Z',
    ...overrides,
  };
  value.sourceTextFingerprint = overrides.sourceTextFingerprint || textFingerprint(value.text);
  return value;
}

function realtimeRequest(overrides = {}) {
  const text = overrides.text || 'こんにちは';
  return {
    sourceTranscriptID: 'transcript-1',
    sourceLanguageCode: 'ja',
    targetLanguageCode: 'en',
    text,
    sourceTextFingerprint: textFingerprint(text),
    idempotencyKey: 'realtime-key-1',
    ...overrides,
  };
}

function fakeGoogle({ supportedCodes = ['ja', 'en', 'zh', 'zh-CN', 'zh-TW'], empty = false } = {}) {
  const calls = { languages: [], translations: [] };
  return {
    calls,
    async listSupportedLanguages(displayLanguageCode) {
      calls.languages.push(displayLanguageCode);
      return supportedCodes.map((code) => ({ code, name: `name:${code}` }));
    },
    async translate(request) {
      calls.translations.push(request);
      return request.texts.map((text) => empty ? '' : `translated:${text}`);
    },
  };
}

async function main() {
  assert.deepStrictEqual(canonicalizeTranslationLanguages([
    { code: 'zh', name: '中国語（簡体）' },
    { code: 'zh-CN', name: '中国語（簡体）' },
    { code: 'zh-TW', name: '中国語（繁体）' },
  ]), [
    { code: 'zh-CN', name: '中国語（簡体）' },
    { code: 'zh-TW', name: '中国語（繁体）' },
  ]);
  assert.strictEqual(areEquivalentLanguages('zh', 'zh-CN'), true);
  assert.strictEqual(areEquivalentLanguages('zh-Hans', 'ZH-cn'), true);
  assert.strictEqual(areEquivalentLanguages('zh-SG', 'zh'), true);
  assert.strictEqual(areEquivalentLanguages('zh-TW', 'zh-Hant'), true);
  assert.strictEqual(areEquivalentLanguages('zh-HK', 'zh-MO'), true);
  assert.strictEqual(areEquivalentLanguages('zh', 'zh-TW'), false);
  assert.strictEqual(areEquivalentLanguages('ja', 'JA'), true);
  assert.strictEqual(googleTranslationLanguageCode('zh-SG'), 'zh-CN');
  assert.strictEqual(googleTranslationLanguageCode('zh-HK'), 'zh-TW');
  assert.strictEqual(googleTranslationLanguageCode('ja'), 'ja');

  const google = fakeGoogle();
  let semanticCalls = 0;
  const semanticBlockService = {
    async groupSegments(segments) {
      semanticCalls += 1;
      return [segments];
    },
  };
  const service = new MojidasTranslationService({
    googleTranslation: google,
    semanticBlockService,
    reuseSecret: 'test-reuse-secret',
  });

  const languages = await service.listSupportedLanguages('ja');
  assert.strictEqual(languages.provider, 'googleCloudTranslationBasicV2');
  assert.strictEqual(languages.languages.length, 4);
  assert.deepStrictEqual(
    languages.languages.filter((language) => language.code.toLowerCase().startsWith('zh')),
    [
      { code: 'zh-CN', name: 'name:zh-CN' },
      { code: 'zh-TW', name: 'name:zh-TW' },
    ]
  );

  const translatedRealtime = await service.translateRealtime({
    userID: 'user-1',
    request: realtimeRequest(),
  });
  assert.strictEqual(translatedRealtime.translatedText, 'translated:こんにちは');
  assert.strictEqual(translatedRealtime.provider, 'googleCloudTranslationBasicV2');
  assert.strictEqual(translatedRealtime.isPassThrough, false);
  assert.strictEqual(google.calls.translations.length, 1);

  const sameIdempotentResult = await service.translateRealtime({
    userID: 'user-1',
    request: realtimeRequest(),
  });
  assert.deepStrictEqual(sameIdempotentResult, translatedRealtime);
  assert.strictEqual(google.calls.translations.length, 1);

  await assert.rejects(
    service.translateRealtime({
      userID: 'user-1',
      request: realtimeRequest({
        text: '異なる本文',
        sourceTextFingerprint: textFingerprint('異なる本文'),
      }),
    }),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT'
  );

  const passThroughGoogle = fakeGoogle();
  const passThroughService = new MojidasTranslationService({
    googleTranslation: passThroughGoogle,
    semanticBlockService,
  });
  const passThroughRealtime = await passThroughService.translateRealtime({
    userID: 'user-1',
    request: realtimeRequest({
      sourceLanguageCode: 'zh',
      targetLanguageCode: 'zh-CN',
      idempotencyKey: 'zh-pass-through',
    }),
  });
  assert.strictEqual(passThroughRealtime.isPassThrough, true);
  assert.strictEqual(passThroughRealtime.provider, 'passthrough');
  assert.strictEqual(passThroughGoogle.calls.translations.length, 0);

  const aliasTranslationGoogle = fakeGoogle();
  const aliasTranslationService = new MojidasTranslationService({
    googleTranslation: aliasTranslationGoogle,
    semanticBlockService,
  });
  await aliasTranslationService.translateRealtime({
    userID: 'user-1',
    request: realtimeRequest({
      sourceLanguageCode: 'zh-HK',
      targetLanguageCode: 'en',
      text: '你好',
      sourceTextFingerprint: textFingerprint('你好'),
      idempotencyKey: 'zh-traditional-to-en',
    }),
  });
  assert.strictEqual(aliasTranslationGoogle.calls.translations[0].sourceLanguageCode, 'zh-TW');

  await aliasTranslationService.translateRealtime({
    userID: 'user-1',
    request: realtimeRequest({
      targetLanguageCode: 'zh-SG',
      idempotencyKey: 'ja-to-zh-simplified',
    }),
  });
  assert.strictEqual(aliasTranslationGoogle.calls.translations[1].targetLanguageCode, 'zh-CN');

  await assert.rejects(
    passThroughService.translateRealtime({
      userID: 'user-1',
      request: realtimeRequest({ sourceTextFingerprint: `sha256-nfc-v1:${'0'.repeat(64)}` }),
    }),
    (error) => error.code === 'SOURCE_TEXT_FINGERPRINT_MISMATCH'
  );

  const formalSegments = [
    sourceSegment('s1', { startMilliseconds: 0, endMilliseconds: 1000 }),
    sourceSegment('s2', { startMilliseconds: 800, endMilliseconds: 1500 }),
    sourceSegment('s3', {
      sourceLanguageCode: 'en',
      startMilliseconds: 1600,
      endMilliseconds: 2200,
      text: 'Already English',
    }),
    sourceSegment('s4', {
      inputID: 'input-2',
      startMilliseconds: 0,
      endMilliseconds: 400,
      label: '話者2',
      colorHex: 'FF0000',
    }),
  ];
  const limitedFormalService = new MojidasTranslationService({
    googleTranslation: fakeGoogle(),
    semanticBlockService,
    maxFormalSegments: 1,
  });
  await assert.rejects(
    limitedFormalService.translateFormal({
      userID: 'user-1',
      request: {
        sourceSessionID: 'session-configured-limit',
        targetLanguageCode: 'en',
        segments: formalSegments.slice(0, 2),
        idempotencyKey: 'formal-configured-limit',
      },
    }),
    (error) => error.code === 'INVALID_TRANSLATION_REQUEST'
  );
  const sentenceService = new MojidasTranslationService({
    googleTranslation: fakeGoogle(),
    reuseSecret: 'sentence-test-secret',
  });
  const sentenceSegments = [
    sourceSegment('sentence-1', {
      text: `${'a'.repeat(65)}。${'b'.repeat(65)}。`,
    }),
    sourceSegment('sentence-2', { text: `${'c'.repeat(65)}。` }),
    sourceSegment('sentence-3', { text: 'd'.repeat(100) }),
    sourceSegment('sentence-4', { text: 'e'.repeat(100) }),
  ];
  const sentenceResult = await sentenceService.translateFormal({
    userID: 'user-1',
    request: {
      sourceSessionID: 'session-sentence-boundaries',
      targetLanguageCode: 'en',
      segments: sentenceSegments,
      idempotencyKey: 'formal-sentence-boundaries',
    },
  });
  assert.deepStrictEqual(
    sentenceResult.blocks.map((block) => block.sourceTranscriptIDs),
    [
      ['sentence-1'],
      ['sentence-1'],
      ['sentence-2'],
      ['sentence-3'],
      ['sentence-4'],
    ]
  );
  const repeatedSourceReuse = await sentenceService.translateFormal({
    userID: 'user-1',
    request: {
      sourceSessionID: 'session-sentence-boundaries',
      targetLanguageCode: 'en',
      segments: sentenceSegments,
      reusableBlocks: sentenceResult.blocks.map((block) => ({
        sourceTranscriptIDs: block.sourceTranscriptIDs,
        sourceTextFingerprint: block.sourceTextFingerprint,
        sourceLanguageCode: block.sourceLanguageCode,
        targetLanguageCode: 'en',
        translatedText: block.translatedText,
        provider: block.provider,
        isPassThrough: block.isPassThrough,
        reuseToken: block.reuseToken,
      })),
      idempotencyKey: 'formal-sentence-boundaries-reuse',
    },
  });
  assert.strictEqual(repeatedSourceReuse.reusedBlockCount, sentenceResult.blocks.length);

  const shortSentenceResult = await sentenceService.translateFormal({
    userID: 'user-1',
    request: {
      sourceSessionID: 'session-short-sentences',
      targetLanguageCode: 'en',
      segments: [sourceSegment('short-sentences', { text: 'はい。そうです。続けます。' })],
      idempotencyKey: 'formal-short-sentences',
    },
  });
  assert.strictEqual(shortSentenceResult.blocks.length, 1);
  assert.deepStrictEqual(shortSentenceResult.blocks[0].sourceTranscriptIDs, ['short-sentences']);
  assert.strictEqual(shortSentenceResult.blocks[0].sourceText, 'はい。そうです。続けます。');

  const formalResult = await service.translateFormal({
    userID: 'user-1',
    request: {
      sourceSessionID: 'session-1',
      targetLanguageCode: 'en',
      segments: formalSegments,
      idempotencyKey: 'formal-key-1',
    },
  });
  assert.strictEqual(formalResult.blocks.length, 3);
  assert.deepStrictEqual(formalResult.blocks[0].sourceTranscriptIDs, ['s1', 's2']);
  assert.strictEqual(formalResult.blocks[0].sourceText, 's1の本文\ns2の本文');
  assert.match(formalResult.blocks[0].sourceTextFingerprint, /^sha256-nfc-v1:[0-9a-f]{64}$/);
  assert.strictEqual(formalResult.blocks[0].translatedText, 'translated:s1の本文\ns2の本文');
  assert.strictEqual(formalResult.blocks[0].startMilliseconds, 0);
  assert.strictEqual(formalResult.blocks[0].endMilliseconds, 1500);
  assert.strictEqual(formalResult.blocks[1].isPassThrough, true);
  assert.strictEqual(formalResult.blocks[1].translatedText, 'Already English');
  assert.strictEqual(formalResult.blocks[1].provider, 'passthrough');
  assert.strictEqual(formalResult.blocks[2].inputID, 'input-2');
  assert.strictEqual(formalResult.blocks[2].label, '話者2');
  assert.strictEqual(formalResult.blocks[2].colorHex, 'FF0000');
  assert.strictEqual(formalResult.billableMilliseconds, 1900);
  assert.strictEqual(formalResult.noTranslationRequired, false);
  assert.strictEqual(semanticCalls, 2);
  assert.deepStrictEqual(
    google.calls.translations.slice(1).map((call) => call.texts),
    [['s1の本文\ns2の本文', 's4の本文']]
  );

  const longLiveGoogle = fakeGoogle();
  const longLiveService = new MojidasTranslationService({
    googleTranslation: longLiveGoogle,
    reuseSecret: 'long-live-test-secret',
  });
  const longLiveSegments = Array.from({ length: 628 }, (_, index) => sourceSegment(
    `live-${index}`,
    {
      startMilliseconds: index * 1000,
      endMilliseconds: index * 1000 + 800,
      text: `ライブ発話${index}です。`,
    }
  ));
  const longLiveResult = await longLiveService.translateFormal({
    userID: 'user-1',
    request: {
      sourceSessionID: 'session-long-live',
      targetLanguageCode: 'en',
      segments: longLiveSegments,
      idempotencyKey: 'formal-long-live',
    },
  });
  assert.strictEqual(
    longLiveResult.blocks.flatMap((block) => block.sourceTranscriptIDs).length,
    longLiveSegments.length
  );
  assert.deepStrictEqual(
    new Set(longLiveResult.blocks.flatMap((block) => block.sourceTranscriptIDs)),
    new Set(longLiveSegments.map((segment) => segment.id))
  );

  const speakerBoundaryResult = await service.translateFormal({
    userID: 'user-1',
    request: {
      sourceSessionID: 'session-speaker-boundary',
      targetLanguageCode: 'en',
      segments: [
        sourceSegment('speaker-a', { label: '話者A' }),
        sourceSegment('speaker-b', { label: '話者B' }),
      ],
      idempotencyKey: 'formal-speaker-boundary',
    },
  });
  assert.deepStrictEqual(
    speakerBoundaryResult.blocks.map((block) => block.sourceTranscriptIDs),
    [['speaker-a'], ['speaker-b']]
  );

  const reusableSourceBlock = formalResult.blocks[0];
  assert.match(reusableSourceBlock.reuseToken, /^mojidas-reuse-v1\.[A-Za-z0-9_-]{43}$/);
  const updateResult = await service.translateFormal({
    userID: 'user-1',
    request: {
      sourceSessionID: 'session-1',
      targetLanguageCode: 'en',
      segments: formalSegments,
      reusableBlocks: [{
        sourceTranscriptIDs: reusableSourceBlock.sourceTranscriptIDs,
        sourceTextFingerprint: reusableSourceBlock.sourceTextFingerprint,
        sourceLanguageCode: reusableSourceBlock.sourceLanguageCode,
        targetLanguageCode: 'en',
        translatedText: reusableSourceBlock.translatedText,
        provider: reusableSourceBlock.provider,
        isPassThrough: reusableSourceBlock.isPassThrough,
        reuseToken: reusableSourceBlock.reuseToken,
      }],
      idempotencyKey: 'formal-key-update',
    },
  });
  assert.strictEqual(updateResult.blocks[0].isReused, true);
  assert.strictEqual(updateResult.blocks[0].translatedText, reusableSourceBlock.translatedText);
  assert.strictEqual(updateResult.blocks[0].reuseToken, reusableSourceBlock.reuseToken);
  assert.strictEqual(updateResult.reusedBlockCount, 1);
  assert.strictEqual(updateResult.billableMilliseconds, 400);
  assert.deepStrictEqual(google.calls.translations.at(-1).texts, ['s4の本文']);

  const macOSTranscriptID = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  const windowsTranscriptID = macOSTranscriptID.toLowerCase();
  const crossOSSourceText = 'OSをまたぐUUID署名テスト';
  const crossOSSourceFingerprint = textFingerprint(crossOSSourceText);
  const macOSResult = await service.translateFormal({
    userID: 'user-1',
    request: {
      sourceSessionID: 'session-cross-os-mac',
      targetLanguageCode: 'en',
      segments: [sourceSegment(macOSTranscriptID, {
        text: crossOSSourceText,
        sourceTextFingerprint: crossOSSourceFingerprint,
      })],
      idempotencyKey: 'formal-cross-os-mac',
    },
  });
  const macOSBlock = macOSResult.blocks[0];
  const windowsReuseResult = await service.translateFormal({
    userID: 'user-1',
    request: {
      sourceSessionID: 'session-cross-os-windows',
      targetLanguageCode: 'en',
      segments: [sourceSegment(windowsTranscriptID, {
        text: crossOSSourceText,
        sourceTextFingerprint: crossOSSourceFingerprint,
      })],
      reusableBlocks: [{
        sourceTranscriptIDs: [windowsTranscriptID],
        sourceTextFingerprint: macOSBlock.sourceTextFingerprint,
        sourceLanguageCode: macOSBlock.sourceLanguageCode,
        targetLanguageCode: 'en',
        translatedText: macOSBlock.translatedText,
        provider: macOSBlock.provider,
        isPassThrough: macOSBlock.isPassThrough,
        reuseToken: macOSBlock.reuseToken,
      }],
      idempotencyKey: 'formal-cross-os-windows',
    },
  });
  assert.strictEqual(windowsReuseResult.blocks[0].isReused, true);
  assert.strictEqual(windowsReuseResult.billableMilliseconds, 0);

  const timingAndLabelUpdateResult = await service.translateFormal({
    userID: 'user-1',
    request: {
      sourceSessionID: 'session-1',
      targetLanguageCode: 'en',
      segments: formalSegments.slice(0, 2).map((segment, index) => ({
        ...segment,
        startMilliseconds: 100 + index * 1000,
        endMilliseconds: 900 + index * 1000,
        label: '変更後の話者名',
      })),
      reusableBlocks: [{
        sourceTranscriptIDs: reusableSourceBlock.sourceTranscriptIDs,
        sourceTextFingerprint: reusableSourceBlock.sourceTextFingerprint,
        sourceLanguageCode: reusableSourceBlock.sourceLanguageCode,
        targetLanguageCode: 'en',
        translatedText: reusableSourceBlock.translatedText,
        provider: reusableSourceBlock.provider,
        isPassThrough: reusableSourceBlock.isPassThrough,
        reuseToken: reusableSourceBlock.reuseToken,
      }],
      idempotencyKey: 'formal-key-timing-label-update',
    },
  });
  assert.strictEqual(timingAndLabelUpdateResult.reusedBlockCount, 1);
  assert.strictEqual(timingAndLabelUpdateResult.billableMilliseconds, 0);
  assert.strictEqual(timingAndLabelUpdateResult.blocks[0].startMilliseconds, 100);
  assert.strictEqual(timingAndLabelUpdateResult.blocks[0].label, '変更後の話者名');

  const reusableMismatchResult = await service.translateFormal({
    userID: 'user-1',
    request: {
      sourceSessionID: 'session-1',
      targetLanguageCode: 'en',
      segments: formalSegments,
      reusableBlocks: [{
        sourceTranscriptIDs: reusableSourceBlock.sourceTranscriptIDs,
        sourceTextFingerprint: `sha256-nfc-v1:${'0'.repeat(64)}`,
        sourceLanguageCode: reusableSourceBlock.sourceLanguageCode,
        targetLanguageCode: 'en',
        translatedText: reusableSourceBlock.translatedText,
        provider: reusableSourceBlock.provider,
        isPassThrough: reusableSourceBlock.isPassThrough,
        reuseToken: reusableSourceBlock.reuseToken,
      }],
      idempotencyKey: 'formal-key-mismatched-reuse',
    },
  });
  assert.strictEqual(reusableMismatchResult.reusedBlockCount, 0);
  assert.strictEqual(reusableMismatchResult.billableMilliseconds, 1900);
  assert.deepStrictEqual(
    google.calls.translations.at(-1).texts,
    ['s1の本文\ns2の本文', 's4の本文']
  );

  const forgedReuseResult = await service.translateFormal({
    userID: 'user-1',
    request: {
      sourceSessionID: 'session-1',
      targetLanguageCode: 'en',
      segments: formalSegments,
      reusableBlocks: [{
        sourceTranscriptIDs: reusableSourceBlock.sourceTranscriptIDs,
        sourceTextFingerprint: reusableSourceBlock.sourceTextFingerprint,
        sourceLanguageCode: reusableSourceBlock.sourceLanguageCode,
        targetLanguageCode: 'en',
        translatedText: 'forged translation',
        provider: reusableSourceBlock.provider,
        isPassThrough: reusableSourceBlock.isPassThrough,
        reuseToken: reusableSourceBlock.reuseToken,
      }],
      idempotencyKey: 'formal-key-forged-reuse',
    },
  });
  assert.strictEqual(forgedReuseResult.reusedBlockCount, 0);
  assert.strictEqual(forgedReuseResult.billableMilliseconds, 1900);
  assert.strictEqual(forgedReuseResult.blocks[0].translatedText, 'translated:s1の本文\ns2の本文');

  const otherUserReuseResult = await service.translateFormal({
    userID: 'user-2',
    request: {
      sourceSessionID: 'session-1',
      targetLanguageCode: 'en',
      segments: formalSegments,
      reusableBlocks: [{
        sourceTranscriptIDs: reusableSourceBlock.sourceTranscriptIDs,
        sourceTextFingerprint: reusableSourceBlock.sourceTextFingerprint,
        sourceLanguageCode: reusableSourceBlock.sourceLanguageCode,
        targetLanguageCode: 'en',
        translatedText: reusableSourceBlock.translatedText,
        provider: reusableSourceBlock.provider,
        isPassThrough: reusableSourceBlock.isPassThrough,
        reuseToken: reusableSourceBlock.reuseToken,
      }],
      idempotencyKey: 'formal-key-other-user-reuse',
    },
  });
  assert.strictEqual(otherUserReuseResult.reusedBlockCount, 0);
  assert.strictEqual(otherUserReuseResult.billableMilliseconds, 1900);

  const noReuseSecretGoogle = fakeGoogle();
  const noReuseSecretService = new MojidasTranslationService({
    googleTranslation: noReuseSecretGoogle,
    semanticBlockService,
    reuseSecret: '',
  });
  const noReuseSecretResult = await noReuseSecretService.translateFormal({
    userID: 'user-1',
    request: {
      sourceSessionID: 'session-1',
      targetLanguageCode: 'en',
      segments: formalSegments.slice(0, 2),
      reusableBlocks: [{
        sourceTranscriptIDs: reusableSourceBlock.sourceTranscriptIDs,
        sourceTextFingerprint: reusableSourceBlock.sourceTextFingerprint,
        sourceLanguageCode: reusableSourceBlock.sourceLanguageCode,
        targetLanguageCode: 'en',
        translatedText: reusableSourceBlock.translatedText,
        provider: reusableSourceBlock.provider,
        isPassThrough: reusableSourceBlock.isPassThrough,
        reuseToken: reusableSourceBlock.reuseToken,
      }],
      idempotencyKey: 'formal-key-no-reuse-secret',
    },
  });
  assert.strictEqual(noReuseSecretResult.reusedBlockCount, 0);
  assert.strictEqual(noReuseSecretResult.billableMilliseconds, 1500);
  assert.strictEqual(noReuseSecretResult.blocks[0].reuseToken, null);

  const previousReuseSecret = process.env.MOJIDAS_TRANSLATION_REUSE_SECRET;
  const previousGoogleKey = process.env.MOJIDAS_GOOGLE_TRANSLATION_API_KEY;
  delete process.env.MOJIDAS_TRANSLATION_REUSE_SECRET;
  process.env.MOJIDAS_GOOGLE_TRANSLATION_API_KEY = 'fallback-signing-key';
  try {
    const fallbackSecretService = new MojidasTranslationService({
      googleTranslation: fakeGoogle(),
      semanticBlockService,
    });
    const fallbackSecretResult = await fallbackSecretService.translateFormal({
      userID: 'user-1',
      request: {
        sourceSessionID: 'session-fallback-secret',
        targetLanguageCode: 'en',
        segments: [sourceSegment('fallback-secret-segment')],
        idempotencyKey: 'formal-key-fallback-secret',
      },
    });
    assert.match(
      fallbackSecretResult.blocks[0].reuseToken,
      /^mojidas-reuse-v1\.[A-Za-z0-9_-]{43}$/
    );
  } finally {
    if (previousReuseSecret === undefined) {
      delete process.env.MOJIDAS_TRANSLATION_REUSE_SECRET;
    } else {
      process.env.MOJIDAS_TRANSLATION_REUSE_SECRET = previousReuseSecret;
    }
    if (previousGoogleKey === undefined) {
      delete process.env.MOJIDAS_GOOGLE_TRANSLATION_API_KEY;
    } else {
      process.env.MOJIDAS_GOOGLE_TRANSLATION_API_KEY = previousGoogleKey;
    }
  }

  const zeroDurationResult = await service.translateFormal({
    userID: 'user-1',
    request: {
      sourceSessionID: 'session-zero-duration',
      targetLanguageCode: 'en',
      segments: [sourceSegment('zero', {
        startMilliseconds: 100,
        endMilliseconds: 100,
      })],
      idempotencyKey: 'formal-zero-duration',
    },
  });
  assert.strictEqual(zeroDurationResult.billableMilliseconds, 0);
  assert.strictEqual(zeroDurationResult.noTranslationRequired, false);

  const directBillable = calculateBillableMilliseconds([
    sourceSegment('a', { startMilliseconds: 0, endMilliseconds: 1000 }),
    sourceSegment('b', { startMilliseconds: 500, endMilliseconds: 1200 }),
    sourceSegment('c', { recognitionRunID: 'run-2', startMilliseconds: 0, endMilliseconds: 800 }),
    sourceSegment('d', { inputID: 'input-2', startMilliseconds: 0, endMilliseconds: 700 }),
    sourceSegment('e', { sourceLanguageCode: 'en', startMilliseconds: 0, endMilliseconds: 5000 }),
  ], 'en');
  assert.strictEqual(directBillable, 2700);

  const onlyPassGoogle = fakeGoogle();
  let onlyPassSemanticCalls = 0;
  const onlyPassService = new MojidasTranslationService({
    googleTranslation: onlyPassGoogle,
    semanticBlockService: {
      async groupSegments() {
        onlyPassSemanticCalls += 1;
        return [];
      },
    },
  });
  const onlyPassResult = await onlyPassService.translateFormal({
    userID: 'user-1',
    request: {
      sourceSessionID: 'session-pass',
      targetLanguageCode: 'zh-CN',
      segments: [sourceSegment('zh-1', { sourceLanguageCode: 'zh', text: '你好' })],
      idempotencyKey: 'formal-pass',
    },
  });
  assert.strictEqual(onlyPassResult.noTranslationRequired, true);
  assert.strictEqual(onlyPassResult.blocks[0].isPassThrough, true);
  assert.strictEqual(onlyPassResult.billableMilliseconds, 0);
  assert.strictEqual(onlyPassSemanticCalls, 0);
  assert.strictEqual(onlyPassGoogle.calls.translations.length, 0);

  const legacyRunSegment = sourceSegment('legacy-zh', {
    sourceLanguageCode: 'zh',
    text: '旧データ',
    colorHex: '#ABCDEF',
  });
  delete legacyRunSegment.recognitionRunID;
  const legacyRunResult = await onlyPassService.translateFormal({
    userID: 'user-1',
    request: {
      sourceSessionID: 'session-legacy-run',
      targetLanguageCode: 'zh-CN',
      segments: [legacyRunSegment],
      idempotencyKey: 'formal-legacy-run',
    },
  });
  assert.strictEqual(legacyRunResult.blocks[0].recognitionRunID, null);
  assert.strictEqual(legacyRunResult.blocks[0].colorHex, 'ABCDEF');

  const unsupportedService = new MojidasTranslationService({
    googleTranslation: fakeGoogle({ supportedCodes: ['ja'] }),
    semanticBlockService,
  });
  await assert.rejects(
    unsupportedService.translateRealtime({ userID: 'user-1', request: realtimeRequest() }),
    (error) => error.code === 'UNSUPPORTED_TRANSLATION_LANGUAGE'
  );

  const emptyGoogleService = new MojidasTranslationService({
    googleTranslation: fakeGoogle({ empty: true }),
    semanticBlockService,
  });
  await assert.rejects(
    emptyGoogleService.translateRealtime({ userID: 'user-1', request: realtimeRequest() }),
    (error) => error.code === 'GOOGLE_TRANSLATION_INVALID_RESPONSE'
  );
}

main()
  .then(() => console.log('Mojidas translation service tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
