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
      return ids[0] === 's1'
        ? structuredResponse([['s1', 's2'], ['s3']])
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
      return structuredResponse([['legacy-1', 'legacy-2']]);
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
  await assert.rejects(
    invalidResponseService.groupSegments([segment('s1'), segment('s2')]),
    (error) => error.code === 'INVALID_SEMANTIC_BOUNDARIES'
  );

  const missingStatusService = new SemanticBlockService({
    apiKey: 'test-openai-key',
    requester: async () => ({
      output: structuredResponse([['s1', 's2']]).output,
    }),
  });
  await assert.rejects(
    missingStatusService.groupSegments([segment('s1'), segment('s2')]),
    (error) => error.code === 'OPENAI_INCOMPLETE_RESPONSE'
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
      return structuredResponse([['s1', 's2']]);
    },
  });
  assert.deepStrictEqual(
    (await retryingService.groupSegments([segment('s1'), segment('s2')]))
      .map((block) => block.map((item) => item.id)),
    [['s1', 's2']]
  );
  assert.strictEqual(retryCalls, 2);

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
}

main()
  .then(() => console.log('Semantic block service tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
