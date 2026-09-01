const https = require('https');

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_SOFT_TARGET_CHARACTERS = 160;
const MAXIMUM_BLOCK_TARGET_MULTIPLIER = 1.5;
const DEFAULT_TIMEOUT_MILLISECONDS = 30 * 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_SEGMENTS = 500;
const MAX_TOTAL_TEXT_CHARACTERS = 100 * 1000;
// Google Cloud Translation Basic v2への後続リクエストが推奨上限を超えないようにする。
const MAX_PROMPT_WINDOW_CHARACTERS = 5000;
const MAX_CONCURRENT_BOUNDARY_REQUESTS = 4;
const LEGACY_RECOGNITION_RUN_SENTINEL = '__legacy_recognition_run__';

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
    apiKey = process.env.OPENAI_API_KEY,
    model = process.env.MOJIDAS_TRANSLATION_BOUNDARY_MODEL || DEFAULT_MODEL,
    endpoint = DEFAULT_ENDPOINT,
    requester = postJSON,
    softTargetCharacters = process.env.MOJIDAS_TRANSLATION_BLOCK_TARGET_CHARACTERS
      || DEFAULT_SOFT_TARGET_CHARACTERS,
  } = {}) {
    this.apiKey = normalizeSecret(apiKey);
    this.model = normalizeModel(model);
    this.endpoint = endpoint;
    this.requester = requester;
    this.softTargetCharacters = normalizeSoftTarget(softTargetCharacters);
    this.maximumBlockCharacters = Math.ceil(
      this.softTargetCharacters * MAXIMUM_BLOCK_TARGET_MULTIPLIER
    );
  }

  async groupSegments(segments) {
    const normalizedSegments = normalizeSegments(segments);
    if (normalizedSegments.length === 0) return [];

    const hardBoundaryGroups = partitionHardBoundaryGroups(normalizedSegments);
    const windowOperations = [];
    for (const hardBoundaryGroup of hardBoundaryGroups) {
      for (const window of partitionPromptWindows(hardBoundaryGroup)) {
        if (window.length === 1) {
          windowOperations.push(async () => [window]);
          continue;
        }
        windowOperations.push(async () => {
          const sourceTranscriptIDGroups = await this.requestBoundaries(window);
          const byID = new Map(window.map((segment) => [segment.id, segment]));
          return sourceTranscriptIDGroups.map((sourceTranscriptIDs) => (
            sourceTranscriptIDs.map((id) => byID.get(id))
          ));
        });
      }
    }
    const windowBlocks = await executeWithConcurrency(
      windowOperations,
      MAX_CONCURRENT_BOUNDARY_REQUESTS
    );
    return windowBlocks.flat();
  }

  async requestBoundaries(segments) {
    if (!this.apiKey) {
      throw new SemanticBlockServiceError(
        'OPENAI_NOT_CONFIGURED',
        '意味ブロック判定サービスの設定が完了していません。'
      );
    }

    // UUIDをそのままLLMへ復唱させると、大文字小文字の変換や長い出力による
    // 欠落が起きやすい。request内だけの短い連番へ置き換え、検証後に戻す。
    const providerSegments = segments.map((segment, index) => ({
      ...segment,
      id: String(index),
    }));
    const providerIDs = providerSegments.map((segment) => segment.id);
    const originalIDByProviderID = new Map(providerSegments.map((segment, index) => (
      [segment.id, segments[index].id]
    )));
    const requestBody = createResponsesRequest({
      model: this.model,
      segments: providerSegments,
      softTargetCharacters: this.softTargetCharacters,
      maximumBlockCharacters: this.maximumBlockCharacters,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.requester({
          endpoint: this.endpoint,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: requestBody,
          timeoutMilliseconds: DEFAULT_TIMEOUT_MILLISECONDS,
          maxResponseBytes: MAX_RESPONSE_BYTES,
        });
        const groups = validateBoundaryOutput(
          providerIDs,
          parseStructuredOutput(response)
        );
        return constrainBoundaryGroups(
          groups,
          providerSegments,
          this.softTargetCharacters,
          this.maximumBlockCharacters
        ).map((group) => group.map((id) => originalIDByProviderID.get(id)));
      } catch (error) {
        const normalized = error instanceof SemanticBlockServiceError
          ? error
          : new SemanticBlockServiceError(
            'OPENAI_REQUEST_FAILED',
            '意味ブロック判定サービスへ接続できませんでした。'
          );
        if (attempt === 0 && shouldRetryOpenAIError(normalized)) continue;
        if (isFallbackBoundaryError(normalized)) {
          return deterministicBoundaryGroups(
            segments,
            this.softTargetCharacters
          ).map((group) => group.map((segment) => segment.id));
        }
        throw normalized;
      }
    }
    throw invalidBoundaryOutput();
  }
}

async function executeWithConcurrency(operations, maximumConcurrency) {
  if (operations.length === 0) return [];
  const results = new Array(operations.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < operations.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operations[index]();
    }
  }
  const workerCount = Math.min(maximumConcurrency, operations.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
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
    if (!segment || typeof segment !== 'object') {
      throw invalidSegmentsError();
    }
    const id = normalizeIdentifier(segment.id);
    const text = typeof segment.text === 'string' ? segment.text.normalize('NFC') : '';
    const inputID = normalizeIdentifier(segment.inputID);
    const recordingID = normalizeIdentifier(segment.recordingID);
    const recognitionRunID = segment.recognitionRunID === null || segment.recognitionRunID === undefined
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

function partitionPromptWindows(segments) {
  const windows = [];
  let current = [];
  let currentCharacters = 0;
  for (const segment of segments) {
    const characters = Array.from(segment.text).length;
    // 後続のGoogle翻訳では発話を改行で結合するため、区切り文字も上限へ含める。
    const separatorCharacters = current.length > 0 ? 1 : 0;
    if (
      current.length > 0
      && currentCharacters + separatorCharacters + characters > MAX_PROMPT_WINDOW_CHARACTERS
    ) {
      windows.push(current);
      current = [];
      currentCharacters = 0;
    }
    if (current.length > 0) currentCharacters += 1;
    current.push(segment);
    currentCharacters += characters;
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

function deterministicBoundaryGroups(segments, targetCharacters) {
  const groups = [];
  let current = [];
  let currentCharacters = 0;
  for (const segment of segments) {
    const characters = Array.from(segment.text).length;
    const separatorCharacters = current.length > 0 ? 1 : 0;
    if (
      current.length > 0
      && currentCharacters + separatorCharacters + characters > targetCharacters
    ) {
      groups.push(current);
      current = [];
      currentCharacters = 0;
    }
    if (current.length > 0) currentCharacters += 1;
    current.push(segment);
    currentCharacters += characters;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function constrainBoundaryGroups(
  groups,
  segments,
  targetCharacters,
  maximumBlockCharacters
) {
  const byID = new Map(segments.map((segment) => [segment.id, segment]));
  const constrained = [];
  for (const group of groups) {
    const groupSegments = group.map((id) => byID.get(id));
    if (joinedCharacterCount(groupSegments) <= maximumBlockCharacters) {
      constrained.push(group);
      continue;
    }
    constrained.push(...deterministicBoundaryGroups(
      groupSegments,
      targetCharacters
    ).map((split) => split.map((segment) => segment.id)));
  }
  return constrained;
}

function joinedCharacterCount(segments) {
  return segments.reduce((total, segment, index) => (
    total + (index > 0 ? 1 : 0) + Array.from(segment.text).length
  ), 0);
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

function createResponsesRequest({
  model,
  segments,
  softTargetCharacters,
  maximumBlockCharacters = Math.ceil(
    softTargetCharacters * MAXIMUM_BLOCK_TARGET_MULTIPLIER
  ),
}) {
  const input = {
    softTargetCharacters,
    maximumBlockCharacters,
    segments: segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
    })),
  };
  return {
    model,
    store: false,
    input: [
      {
        role: 'system',
        content: [{
          type: 'input_text',
          text: [
            'あなたは字幕翻訳前の意味ブロック境界だけを決めます。',
            '本文を翻訳・要約・修正せず、入力IDを連続したグループへ分けてください。',
            'IDは短い数字文字列です。文字列を変更せず完全一致で返してください。',
            '全IDを入力順のまま重複・欠落なく一度ずつ返してください。',
            '文や意味のまとまりを優先し、各ブロックはsoftTargetCharacters付近を目安にしてください。',
            '単一の入力発話だけで上限を超える場合を除き、各ブロックはmaximumBlockCharacters以下にしてください。',
          ].join(''),
        }],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: JSON.stringify(input) }],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'mojidas_semantic_blocks',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            blocks: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  sourceTranscriptIDs: {
                    type: 'array',
                    minItems: 1,
                    items: { type: 'string' },
                  },
                },
                required: ['sourceTranscriptIDs'],
                additionalProperties: false,
              },
            },
          },
          required: ['blocks'],
          additionalProperties: false,
        },
      },
    },
  };
}

function parseStructuredOutput(response) {
  if (!response || typeof response !== 'object') {
    throw invalidOpenAIResponse();
  }
  if (response.status !== 'completed') {
    throw new SemanticBlockServiceError(
      'OPENAI_INCOMPLETE_RESPONSE',
      '意味ブロック判定が完了しませんでした。'
    );
  }

  let outputText = typeof response.output_text === 'string' ? response.output_text : '';
  let nestedOutputText = '';
  if (Array.isArray(response.output)) {
    for (const output of response.output) {
      if (!output || !Array.isArray(output.content)) continue;
      for (const content of output.content) {
        if (content && content.type === 'refusal') {
          throw new SemanticBlockServiceError(
            'OPENAI_REFUSED',
            '意味ブロック判定を実行できませんでした。'
          );
        }
        if (content && content.type === 'output_text' && typeof content.text === 'string') {
          nestedOutputText += content.text;
        }
      }
    }
  }
  if (nestedOutputText) outputText = nestedOutputText;
  if (!outputText) throw invalidOpenAIResponse();

  try {
    return JSON.parse(outputText);
  } catch (error) {
    throw invalidOpenAIResponse();
  }
}

function validateBoundaryOutput(expectedIDs, output) {
  if (
    !hasExactObjectKeys(output, ['blocks'])
    || !Array.isArray(output.blocks)
    || output.blocks.length === 0
  ) {
    throw invalidBoundaryOutput();
  }
  const groups = [];
  const flattened = [];
  for (const block of output.blocks) {
    if (
      !hasExactObjectKeys(block, ['sourceTranscriptIDs'])
      || !Array.isArray(block.sourceTranscriptIDs)
      || block.sourceTranscriptIDs.length === 0
    ) {
      throw invalidBoundaryOutput();
    }
    const ids = block.sourceTranscriptIDs.map((id) => normalizeIdentifier(id));
    if (ids.some((id) => !id)) throw invalidBoundaryOutput();
    groups.push(ids);
    flattened.push(...ids);
  }
  if (
    flattened.length !== expectedIDs.length
    || flattened.some((id, index) => id !== expectedIDs[index])
  ) {
    throw invalidBoundaryOutput();
  }
  return groups;
}

function hasExactObjectKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
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

function normalizeSecret(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeModel(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || DEFAULT_MODEL;
}

function normalizeSoftTarget(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 50 && parsed <= 2000
    ? parsed
    : DEFAULT_SOFT_TARGET_CHARACTERS;
}

function invalidSegmentsError() {
  return new SemanticBlockServiceError(
    'INVALID_TRANSLATION_SEGMENTS',
    '意味ブロックに使用する発話が正しくありません。'
  );
}

function invalidBoundaryOutput() {
  return new SemanticBlockServiceError(
    'INVALID_SEMANTIC_BOUNDARIES',
    '意味ブロック判定の応答が入力発話と一致しません。'
  );
}

function invalidOpenAIResponse() {
  return new SemanticBlockServiceError(
    'OPENAI_INVALID_RESPONSE',
    '意味ブロック判定サービスから有効な応答を取得できませんでした。'
  );
}

function isRetryableOpenAIError(error) {
  if (!error) return false;
  if (['OPENAI_TIMEOUT', 'OPENAI_RATE_LIMITED'].includes(error.code)) return true;
  if (error.code !== 'OPENAI_REQUEST_FAILED') return false;
  return !Number.isInteger(error.statusCode) || error.statusCode >= 500;
}

function shouldRetryOpenAIError(error) {
  return isRetryableOpenAIError(error) || isFallbackBoundaryError(error);
}

function isFallbackBoundaryError(error) {
  return Boolean(error && [
    'OPENAI_INVALID_RESPONSE',
    'OPENAI_INCOMPLETE_RESPONSE',
    'INVALID_SEMANTIC_BOUNDARIES',
  ].includes(error.code));
}

function postJSON({ endpoint, headers, body, timeoutMilliseconds, maxResponseBytes }) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishWithError = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = https.request(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let responseBody = '';
      let responseBytes = 0;
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > maxResponseBytes) {
          response.destroy();
          finishWithError(new SemanticBlockServiceError(
            'OPENAI_INVALID_RESPONSE',
            '意味ブロック判定サービスの応答が大きすぎます。'
          ));
          return;
        }
        responseBody += chunk;
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        let parsed;
        try {
          parsed = responseBody ? JSON.parse(responseBody) : {};
        } catch (error) {
          reject(invalidOpenAIResponse());
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new SemanticBlockServiceError(
            response.statusCode === 429 ? 'OPENAI_RATE_LIMITED' : 'OPENAI_REQUEST_FAILED',
            '意味ブロック判定サービスでエラーが発生しました。',
            response.statusCode
          ));
          return;
        }
        resolve(parsed);
      });
      response.on('error', finishWithError);
    });
    request.setTimeout(timeoutMilliseconds, () => {
      request.destroy();
      finishWithError(new SemanticBlockServiceError(
        'OPENAI_TIMEOUT',
        '意味ブロック判定サービスがタイムアウトしました。'
      ));
    });
    request.on('error', () => finishWithError(new SemanticBlockServiceError(
      'OPENAI_REQUEST_FAILED',
      '意味ブロック判定サービスへ接続できませんでした。'
    )));
    request.write(payload);
    request.end();
  });
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_SOFT_TARGET_CHARACTERS,
  SemanticBlockService,
  SemanticBlockServiceError,
  createResponsesRequest,
  constrainBoundaryGroups,
  deterministicBoundaryGroups,
  hardBoundaryKey,
  normalizeLanguageCode,
  partitionHardBoundaryGroups,
  parseStructuredOutput,
  validateBoundaryOutput,
};
