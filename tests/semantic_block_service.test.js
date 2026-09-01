const assert = require('assert');

const {
  SemanticBlockService,
  SemanticBlockServiceError,
  createResponsesRequest,
  partitionHardBoundaryGroups,
  validateBoundaryOutput,
} = require('../modules/translation/semantic_block_service');

function segment(id, overrides = {}) {
  return {
    id,
    inputID: 'input-1',
    recordingID: 'recording-1',
    recognitionRunID: 'run-1',
    sourceLanguageCode: 'ja',
    label: '話者1',
    text: `${id}の本文です。`,
    ...overrides,
  };
}

function structuredResponse(blocks) {
  return {
    status: 'completed',
    output: [{
      type: 'message',
      content: [{
        type: 'output_text',
        text: JSON.stringify({
          blocks: blocks.map((sourceTranscriptIDs) => ({ sourceTranscriptIDs })),
        }),
      }],
    }],
  };
}

async function main() {
  const single = new SemanticBlockService();
  assert.deepStrictEqual(
    await single.groupSegments([segment('s1')]),
    [[segment('s1')]]
  );

  const calls = [];
  const service = new SemanticBlockService({
    apiKey: 'test-openai-key',
    model: 'test-boundary-model',
    requester: async (request) => {
      calls.push(request);
      const userInput = JSON.parse(request.body.input[1].content[0].text);
      const ids = userInput.segments.map((item) => item.id);
      return ids.length === 3
        ? structuredResponse([['0', '1'], ['2']])
        : structuredResponse([ids]);
    },
  });
  const sourceSegments = [
    segment('s1'),
    segment('s2'),
    segment('s3'),
    segment('s4', { inputID: 'input-2' }),
    segment('s5', { inputID: 'input-2' }),
  ];
  const blocks = await service.groupSegments(sourceSegments);
  assert.deepStrictEqual(blocks.map((block) => block.map((item) => item.id)), [
    ['s1', 's2'],
    ['s3'],
    ['s4', 's5'],
  ]);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].body.model, 'test-boundary-model');
  assert.strictEqual(calls[0].body.store, false);
  assert.strictEqual(calls[0].body.text.format.type, 'json_schema');
  assert.strictEqual(calls[0].body.text.format.strict, true);
  assert.match(calls[0].headers.Authorization, /^Bearer /);
  assert.deepStrictEqual(
    JSON.parse(calls[0].body.input[1].content[0].text)
      .segments.map((item) => item.id),
    ['0', '1', '2']
  );
  const firstBoundaryInput = JSON.parse(calls[0].body.input[1].content[0].text);
  assert.strictEqual(firstBoundaryInput.softTargetCharacters, 160);
  assert.strictEqual(firstBoundaryInput.maximumBlockCharacters, 240);

  const hardGroups = partitionHardBoundaryGroups([
    segment('a'),
    segment('b'),
    segment('c', { recordingID: 'recording-2' }),
    segment('d', { recordingID: 'recording-2', sourceLanguageCode: 'en' }),
    segment('e', { recordingID: 'recording-2', sourceLanguageCode: 'en' }),
    segment('f', {
      recordingID: 'recording-2',
      sourceLanguageCode: 'en',
      label: '話者2',
    }),
  ]);
  assert.deepStrictEqual(hardGroups.map((group) => group.map((item) => item.id)), [
    ['a', 'b'],
    ['c'],
    ['d', 'e'],
    ['f'],
  ]);

  let legacyRunCalls = 0;
  const legacyRunService = new SemanticBlockService({
    apiKey: 'test-openai-key',
    requester: async () => {
      legacyRunCalls += 1;
      return structuredResponse([['0', '1']]);
    },
  });
  const missingRun = segment('legacy-1');
  delete missingRun.recognitionRunID;
  const legacyRunBlocks = await legacyRunService.groupSegments([
    missingRun,
    segment('legacy-2', { recognitionRunID: null }),
  ]);
  assert.deepStrictEqual(
    legacyRunBlocks.map((block) => block.map((item) => item.id)),
    [['legacy-1', 'legacy-2']]
  );
  assert.strictEqual(legacyRunCalls, 1);

  assert.deepStrictEqual(
    validateBoundaryOutput(['a', 'b', 'c'], {
      blocks: [
        { sourceTranscriptIDs: ['a', 'b'] },
        { sourceTranscriptIDs: ['c'] },
      ],
    }),
    [['a', 'b'], ['c']]
  );

  const invalidOutputs = [
    { blocks: [{ sourceTranscriptIDs: ['a', 'b'] }] },
    { blocks: [{ sourceTranscriptIDs: ['a', 'b', 'b', 'c'] }] },
    { blocks: [{ sourceTranscriptIDs: ['a', 'c'] }, { sourceTranscriptIDs: ['b'] }] },
    { blocks: [{ sourceTranscriptIDs: ['b', 'a', 'c'] }] },
    { blocks: [] },
    { blocks: [{ sourceTranscriptIDs: ['a', 'b', 'c'], extra: true }] },
    { blocks: [{ sourceTranscriptIDs: ['a', 'b', 'c'] }], extra: true },
  ];
  for (const output of invalidOutputs) {
    assert.throws(
      () => validateBoundaryOutput(['a', 'b', 'c'], output),
      (error) => error.code === 'INVALID_SEMANTIC_BOUNDARIES'
    );
  }

  const invalidResponseService = new SemanticBlockService({
    apiKey: 'test-openai-key',
    requester: async () => structuredResponse([['s1']]),
  });
  assert.deepStrictEqual(
    (await invalidResponseService.groupSegments([segment('s1'), segment('s2')]))
      .map((block) => block.map((item) => item.id)),
    [['s1', 's2']]
  );

  const missingStatusService = new SemanticBlockService({
    apiKey: 'test-openai-key',
    requester: async () => ({
      output: structuredResponse([['s1', 's2']]).output,
    }),
  });
  assert.deepStrictEqual(
    (await missingStatusService.groupSegments([segment('s1'), segment('s2')]))
      .map((block) => block.map((item) => item.id)),
    [['s1', 's2']]
  );

  const refusalService = new SemanticBlockService({
    apiKey: 'test-openai-key',
    requester: async () => ({
      ...structuredResponse([['s1', 's2']]),
      output_text: JSON.stringify({
        blocks: [{ sourceTranscriptIDs: ['s1', 's2'] }],
      }),
      output: [{ content: [{ type: 'refusal', refusal: 'no' }] }],
    }),
  });
  await assert.rejects(
    refusalService.groupSegments([segment('s1'), segment('s2')]),
    (error) => error.code === 'OPENAI_REFUSED'
  );

  let retryCalls = 0;
  const retryingService = new SemanticBlockService({
    apiKey: 'test-openai-key',
    requester: async () => {
      retryCalls += 1;
      if (retryCalls === 1) {
        throw new SemanticBlockServiceError('OPENAI_RATE_LIMITED', 'temporary', 429);
      }
      return structuredResponse([['0', '1']]);
    },
  });
  assert.deepStrictEqual(
    (await retryingService.groupSegments([segment('s1'), segment('s2')]))
      .map((block) => block.map((item) => item.id)),
    [['s1', 's2']]
  );
  assert.strictEqual(retryCalls, 2);

  let invalidBoundaryRetryCalls = 0;
  const invalidBoundaryRetryService = new SemanticBlockService({
    apiKey: 'test-openai-key',
    requester: async () => {
      invalidBoundaryRetryCalls += 1;
      return invalidBoundaryRetryCalls === 1
        ? structuredResponse([['1', '0']])
        : structuredResponse([['0'], ['1']]);
    },
  });
  assert.deepStrictEqual(
    (await invalidBoundaryRetryService.groupSegments([
      segment('UPPERCASE-ID-A'),
      segment('UPPERCASE-ID-B'),
    ])).map((block) => block.map((item) => item.id)),
    [['UPPERCASE-ID-A'], ['UPPERCASE-ID-B']]
  );
  assert.strictEqual(invalidBoundaryRetryCalls, 2);

  const macUUIDs = [
    'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
  ];
  let uuidProviderIDs;
  let uuidProviderInput;
  const uuidService = new SemanticBlockService({
    apiKey: 'test-openai-key',
    requester: async (request) => {
      uuidProviderInput = request.body.input[1].content[0].text;
      const input = JSON.parse(request.body.input[1].content[0].text);
      uuidProviderIDs = input.segments.map((item) => item.id);
      return structuredResponse([['0', '1']]);
    },
  });
  assert.deepStrictEqual(
    (await uuidService.groupSegments(macUUIDs.map((id) => segment(id, {
      text: 'UUIDを含まない合成本文です。',
    })))).map((block) => block.map((item) => item.id)),
    [macUUIDs]
  );
  assert.deepStrictEqual(uuidProviderIDs, ['0', '1']);
  for (const id of macUUIDs) assert.ok(!uuidProviderInput.includes(id));

  let fallbackCalls = 0;
  const fallbackService = new SemanticBlockService({
    apiKey: 'test-openai-key',
    softTargetCharacters: 50,
    requester: async () => {
      fallbackCalls += 1;
      return structuredResponse([['missing']]);
    },
  });
  assert.deepStrictEqual(
    (await fallbackService.groupSegments([
      segment('fallback-1', { text: 'a'.repeat(30) }),
      segment('fallback-2', { text: 'b'.repeat(30) }),
      segment('fallback-3', { text: 'c'.repeat(30) }),
    ])).map((block) => block.map((item) => item.id)),
    [['fallback-1'], ['fallback-2'], ['fallback-3']]
  );
  assert.strictEqual(fallbackCalls, 2);

  let oversizedBoundaryCalls = 0;
  const oversizedBoundaryService = new SemanticBlockService({
    apiKey: 'test-openai-key',
    requester: async () => {
      oversizedBoundaryCalls += 1;
      return structuredResponse([['0', '1', '2']]);
    },
  });
  assert.deepStrictEqual(
    (await oversizedBoundaryService.groupSegments([
      segment('oversized-1', { text: 'a'.repeat(100) }),
      segment('oversized-2', { text: 'b'.repeat(100) }),
      segment('oversized-3', { text: 'c'.repeat(100) }),
    ])).map((block) => block.map((item) => item.id)),
    [['oversized-1'], ['oversized-2'], ['oversized-3']]
  );
  assert.strictEqual(oversizedBoundaryCalls, 1);

  let exhaustedRetryCalls = 0;
  const exhaustedRetryService = new SemanticBlockService({
    apiKey: 'test-openai-key',
    requester: async () => {
      exhaustedRetryCalls += 1;
      throw new SemanticBlockServiceError('OPENAI_REQUEST_FAILED', 'temporary', 500);
    },
  });
  await assert.rejects(
    exhaustedRetryService.groupSegments([segment('s1'), segment('s2')]),
    (error) => error.code === 'OPENAI_REQUEST_FAILED'
  );
  assert.strictEqual(exhaustedRetryCalls, 2);

  let oversizedJoinCalls = 0;
  const boundedJoinService = new SemanticBlockService({
    apiKey: 'test-openai-key',
    requester: async () => {
      oversizedJoinCalls += 1;
      throw new Error('5,000文字を超える結合はOpenAIへ送らない');
    },
  });
  const boundedJoinBlocks = await boundedJoinService.groupSegments([
    segment('long-1', { text: 'a'.repeat(2500) }),
    segment('long-2', { text: 'b'.repeat(2500) }),
  ]);
  assert.deepStrictEqual(
    boundedJoinBlocks.map((block) => block.map((item) => item.id)),
    [['long-1'], ['long-2']]
  );
  assert.strictEqual(oversizedJoinCalls, 0);

  const missingKeyService = new SemanticBlockService({ apiKey: '' });
  await assert.rejects(
    missingKeyService.groupSegments([segment('s1'), segment('s2')]),
    (error) => error.code === 'OPENAI_NOT_CONFIGURED'
  );

  const structuredRequest = createResponsesRequest({
    model: 'test-model',
    segments: [segment('s1')],
    softTargetCharacters: 300,
  });
  assert.strictEqual(structuredRequest.store, false);
  assert.strictEqual(structuredRequest.text.format.schema.additionalProperties, false);
  const structuredInput = JSON.parse(structuredRequest.input[1].content[0].text);
  assert.strictEqual(structuredInput.maximumBlockCharacters, 450);
}

main()
  .then(() => console.log('Semantic block service tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
