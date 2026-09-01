const assert = require('assert');

const {
  DEFAULT_MINIMUM_BLOCK_CHARACTERS,
  DEFAULT_MAXIMUM_BLOCK_CHARACTERS,
  SemanticBlockService,
  hasSentenceEnding,
  partitionHardBoundaryGroups,
  splitSegmentAtSentenceEndings,
} = require('../modules/translation/semantic_block_service');

function segment(id, overrides = {}) {
  return {
    id,
    inputID: 'input-1',
    recordingID: 'recording-1',
    recognitionRunID: 'run-1',
    sourceLanguageCode: 'ja',
    label: '話者1',
    text: `${id}の本文`,
    ...overrides,
  };
}

function sourceIDs(blocks) {
  return blocks.map((block) => block.map((item) => item.sourceTranscriptID || item.id));
}

async function main() {
  assert.strictEqual(DEFAULT_MINIMUM_BLOCK_CHARACTERS, 60);
  assert.strictEqual(DEFAULT_MAXIMUM_BLOCK_CHARACTERS, 160);
  assert.strictEqual(hasSentenceEnding('文です。'), true);
  assert.strictEqual(hasSentenceEnding('文です！」'), true);
  assert.strictEqual(hasSentenceEnding('Sentence?'), true);
  assert.strictEqual(hasSentenceEnding('まだ続く'), false);

  const service = new SemanticBlockService({ minimumBlockCharacters: 10 });
  const sentenceBlocks = await service.groupSegments([
    segment('s1', { text: 'これは' }),
    segment('s2', { text: '最初の文です。' }),
    segment('s3', { text: '次の文章として十分です！' }),
    segment('s4', { text: '句点がなく' }),
    segment('s5', { text: '最後まで続きます' }),
  ]);
  assert.deepStrictEqual(sourceIDs(sentenceBlocks), [
    ['s1', 's2'],
    ['s3'],
    ['s4', 's5'],
  ]);

  const defaultService = new SemanticBlockService();
  const mergedShortSentences = await defaultService.groupSegments([
    segment('short-1', { text: 'はい。' }),
    segment('short-2', { text: 'そうです。' }),
    segment('short-3', { text: 'もう少し詳しく説明するための文章です。'.repeat(2) }),
  ]);
  assert.deepStrictEqual(sourceIDs(mergedShortSentences), [
    ['short-1', 'short-2', 'short-3', 'short-3'],
  ]);

  const cappedService = new SemanticBlockService({ maximumBlockCharacters: 50 });
  const cappedBlocks = await cappedService.groupSegments([
    segment('cap-1', { text: 'a'.repeat(30) }),
    segment('cap-2', { text: 'b'.repeat(30) }),
    segment('cap-3', { text: 'c'.repeat(10) + '。' }),
  ]);
  assert.deepStrictEqual(sourceIDs(cappedBlocks), [
    ['cap-1'],
    ['cap-2', 'cap-3'],
  ]);

  const singleLongBlock = await cappedService.groupSegments([
    segment('long', { text: 'a'.repeat(80) }),
  ]);
  assert.deepStrictEqual(sourceIDs(singleLongBlock), [
    ['long'],
    ['long'],
  ]);

  const splitSource = segment('multi-sentence', {
    text: '一文です。二文目です！最後です。',
    startMilliseconds: 1000,
    endMilliseconds: 4000,
  });
  const splitFragments = splitSegmentAtSentenceEndings(splitSource, 160);
  assert.deepStrictEqual(splitFragments.map((item) => item.text), [
    '一文です。',
    '二文目です！',
    '最後です。',
  ]);
  assert.strictEqual(splitFragments[0].startMilliseconds, 1000);
  assert.strictEqual(splitFragments[splitFragments.length - 1].endMilliseconds, 4000);
  assert.ok(splitFragments[0].endMilliseconds <= splitFragments[1].startMilliseconds);

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

  const hardBoundaryBlocks = await service.groupSegments([
    segment('hard-1', { text: '前半' }),
    segment('hard-2', { text: '後半。', inputID: 'input-2' }),
  ]);
  assert.deepStrictEqual(sourceIDs(hardBoundaryBlocks), [
    ['hard-1'],
    ['hard-2'],
  ]);

  const missingRun = segment('legacy-1');
  delete missingRun.recognitionRunID;
  const legacyBlocks = await service.groupSegments([
    missingRun,
    segment('legacy-2', { recognitionRunID: null, text: '完了。' }),
  ]);
  assert.deepStrictEqual(sourceIDs(legacyBlocks), [
    ['legacy-1', 'legacy-2'],
  ]);

  await assert.rejects(
    service.groupSegments([segment('duplicate'), segment('duplicate')]),
    (error) => error.code === 'INVALID_TRANSLATION_SEGMENTS'
  );
  await assert.rejects(
    service.groupSegments([segment('empty', { text: '   ' })]),
    (error) => error.code === 'INVALID_TRANSLATION_SEGMENTS'
  );
  const limitedService = new SemanticBlockService({
    maxSegments: 1,
    maxTotalTextCharacters: 1000,
  });
  await assert.rejects(
    limitedService.groupSegments([segment('limit-1'), segment('limit-2')]),
    (error) => error.code === 'INVALID_TRANSLATION_SEGMENTS'
      && error.message.includes('最大1件')
  );
  await assert.rejects(
    limitedService.groupSegments([segment('too-long', { text: 'a'.repeat(1001) })]),
    (error) => error.code === 'TRANSLATION_INPUT_TOO_LARGE'
      && error.message.includes('最大1000文字')
  );

  const noKeyService = new SemanticBlockService();
  assert.deepStrictEqual(
    (await noKeyService.groupSegments([
      segment('no-key-1'),
      segment('no-key-2', { text: 'APIキーなしでも完了。' }),
    ])).map((block) => block.map((item) => item.sourceTranscriptID || item.id)),
    [['no-key-1', 'no-key-2']]
  );
}

main()
  .then(() => console.log('Semantic block service tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
