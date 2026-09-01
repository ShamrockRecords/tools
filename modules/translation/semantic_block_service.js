const DEFAULT_MINIMUM_BLOCK_CHARACTERS = 60;
const DEFAULT_MAXIMUM_BLOCK_CHARACTERS = 160;
const MAX_SEGMENTS = 2000;
const MAX_TOTAL_TEXT_CHARACTERS = 100 * 1000;
const LEGACY_RECOGNITION_RUN_SENTINEL = '__legacy_recognition_run__';
const SENTENCE_END_PATTERN = /[。！？.!?](?:["'”’」』】）)\]]*)$/u;
const SENTENCE_END_CHARACTERS = new Set(['。', '！', '？', '.', '!', '?']);
const CLOSING_CHARACTERS = new Set(['"', "'", '”', '’', '」', '』', '】', '）', ')', ']']);

class SemanticBlockServiceError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = 'SemanticBlockServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

class SemanticBlockService {
  constructor({
    minimumBlockCharacters,
    maximumBlockCharacters,
    // 直前の実装で追加した設定名も互換用に受け付ける。
    softTargetCharacters,
  } = {}) {
    this.maximumBlockCharacters = normalizeBlockCharacters(
      maximumBlockCharacters
        ?? process.env.MOJIDAS_TRANSLATION_BLOCK_MAX_CHARACTERS
        ?? softTargetCharacters
        ?? process.env.MOJIDAS_TRANSLATION_BLOCK_TARGET_CHARACTERS
        ?? DEFAULT_MAXIMUM_BLOCK_CHARACTERS,
      DEFAULT_MAXIMUM_BLOCK_CHARACTERS
    );
    this.minimumBlockCharacters = Math.min(
      normalizeBlockCharacters(
        minimumBlockCharacters
          ?? process.env.MOJIDAS_TRANSLATION_BLOCK_MIN_CHARACTERS
          ?? DEFAULT_MINIMUM_BLOCK_CHARACTERS,
        DEFAULT_MINIMUM_BLOCK_CHARACTERS
      ),
      this.maximumBlockCharacters
    );
  }

  async groupSegments(segments) {
    const normalizedSegments = normalizeSegments(segments);
    const fragments = normalizedSegments.flatMap((segment) => (
      splitSegmentAtSentenceEndings(segment, this.maximumBlockCharacters)
    ));
    return partitionHardBoundaryGroups(fragments).flatMap((group) => (
      sentenceBoundaryGroups(
        group,
        this.maximumBlockCharacters,
        this.minimumBlockCharacters
      )
    ));
  }
}

function normalizeSegments(segments) {
  if (!Array.isArray(segments) || segments.length > MAX_SEGMENTS) {
    throw new SemanticBlockServiceError(
      'INVALID_TRANSLATION_SEGMENTS',
      `意味ブロックに指定できる発話は最大${MAX_SEGMENTS}件です。`
    );
  }

  let totalCharacters = 0;
  const seenIDs = new Set();
  return segments.map((segment) => {
    if (!segment || typeof segment !== 'object') throw invalidSegmentsError();
    const id = normalizeIdentifier(segment.id);
    const text = typeof segment.text === 'string' ? segment.text.normalize('NFC') : '';
    const inputID = normalizeIdentifier(segment.inputID);
    const recordingID = normalizeIdentifier(segment.recordingID);
    const recognitionRunID = segment.recognitionRunID === null
      || segment.recognitionRunID === undefined
      ? null
      : normalizeIdentifier(segment.recognitionRunID);
    const sourceLanguageCode = normalizeLanguageCode(segment.sourceLanguageCode);
    const label = typeof segment.label === 'string' ? segment.label.normalize('NFC').trim() : null;
    if (
      !id
      || seenIDs.has(id)
      || !text.trim()
      || !inputID
      || !recordingID
      || recognitionRunID === ''
      || !sourceLanguageCode
      || label === null
    ) {
      throw invalidSegmentsError();
    }
    seenIDs.add(id);
    totalCharacters += Array.from(text).length;
    if (totalCharacters > MAX_TOTAL_TEXT_CHARACTERS) {
      throw new SemanticBlockServiceError(
        'TRANSLATION_INPUT_TOO_LARGE',
        `意味ブロック判定へ送信できる本文は最大${MAX_TOTAL_TEXT_CHARACTERS}文字です。`
      );
    }
    return {
      ...segment,
      id,
      text,
      inputID,
      recordingID,
      recognitionRunID,
      sourceLanguageCode,
      label,
    };
  });
}

function partitionHardBoundaryGroups(segments) {
  const groups = [];
  for (const segment of segments) {
    const current = groups[groups.length - 1];
    if (!current || hardBoundaryKey(current[0]) !== hardBoundaryKey(segment)) {
      groups.push([segment]);
    } else {
      current.push(segment);
    }
  }
  return groups;
}

function sentenceBoundaryGroups(
  segments,
  maximumBlockCharacters,
  minimumBlockCharacters = DEFAULT_MINIMUM_BLOCK_CHARACTERS
) {
  const groups = [];
  let current = [];
  let currentCharacters = 0;

  const finishCurrent = () => {
    if (current.length === 0) return;
    groups.push(current);
    current = [];
    currentCharacters = 0;
  };

  for (const segment of segments) {
    const characters = Array.from(segment.text).length;
    const separatorCharacters = current.length > 0 ? 1 : 0;
    if (
      current.length > 0
      && currentCharacters + separatorCharacters + characters > maximumBlockCharacters
    ) {
      // 文末が現れない長文だけを、元発話の境界で上限内へ分ける。
      finishCurrent();
    }
    if (current.length > 0) currentCharacters += 1;
    current.push(segment);
    currentCharacters += characters;

    if (
      hasSentenceEnding(segment.text)
      && currentCharacters >= minimumBlockCharacters
    ) finishCurrent();
  }
  finishCurrent();
  return groups;
}

function splitSegmentAtSentenceEndings(segment, maximumBlockCharacters) {
  const characters = Array.from(segment.text);
  const slices = [];
  let start = 0;
  let index = 0;
  while (index < characters.length) {
    if (!SENTENCE_END_CHARACTERS.has(characters[index])) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < characters.length && CLOSING_CHARACTERS.has(characters[end])) end += 1;
    appendBoundedSlices(slices, characters, start, end, maximumBlockCharacters);
    start = end;
    index = end;
  }
  appendBoundedSlices(slices, characters, start, characters.length, maximumBlockCharacters);

  const totalCharacters = characters.length;
  const duration = Math.max(0, segment.endMilliseconds - segment.startMilliseconds);
  return slices.map((slice, sliceIndex) => ({
    ...segment,
    id: `${segment.id}:${sliceIndex}`,
    sourceTranscriptID: segment.id,
    text: slice.text,
    startMilliseconds: segment.startMilliseconds
      + proportionalOffset(duration, slice.start, totalCharacters),
    endMilliseconds: segment.startMilliseconds
      + proportionalOffset(duration, slice.end, totalCharacters),
  }));
}

function appendBoundedSlices(slices, characters, start, end, maximumBlockCharacters) {
  let cursor = start;
  while (cursor < end) {
    const sliceEnd = Math.min(end, cursor + maximumBlockCharacters);
    const text = characters.slice(cursor, sliceEnd).join('').trim();
    if (text) slices.push({ text, start: cursor, end: sliceEnd });
    cursor = sliceEnd;
  }
}

function proportionalOffset(duration, consumedCharacters, totalCharacters) {
  if (totalCharacters <= 0 || consumedCharacters <= 0) return 0;
  if (consumedCharacters >= totalCharacters) return duration;
  return Math.round(duration * consumedCharacters / totalCharacters);
}

function hasSentenceEnding(text) {
  return SENTENCE_END_PATTERN.test(text.trim());
}

function hardBoundaryKey(segment) {
  return JSON.stringify([
    segment.inputID,
    segment.recordingID,
    segment.recognitionRunID === null
      ? LEGACY_RECOGNITION_RUN_SENTINEL
      : segment.recognitionRunID,
    segment.sourceLanguageCode,
    segment.label,
  ]);
}

function normalizeIdentifier(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized && normalized.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(normalized)
    ? normalized
    : '';
}

function normalizeLanguageCode(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized && normalized.length <= 35 && /^[A-Za-z0-9-]+$/.test(normalized)
    ? normalized
    : '';
}

function normalizeBlockCharacters(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 10 && parsed <= 2000
    ? parsed
    : fallback;
}

function invalidSegmentsError() {
  return new SemanticBlockServiceError(
    'INVALID_TRANSLATION_SEGMENTS',
    '意味ブロックに使用する発話が正しくありません。'
  );
}

module.exports = {
  DEFAULT_MINIMUM_BLOCK_CHARACTERS,
  DEFAULT_MAXIMUM_BLOCK_CHARACTERS,
  SemanticBlockService,
  SemanticBlockServiceError,
  deterministicBoundaryGroups: sentenceBoundaryGroups,
  hardBoundaryKey,
  hasSentenceEnding,
  normalizeLanguageCode,
  partitionHardBoundaryGroups,
  sentenceBoundaryGroups,
  splitSegmentAtSentenceEndings,
};
