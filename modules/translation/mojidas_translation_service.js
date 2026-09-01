const crypto = require('crypto');

const { GoogleCloudTranslation } = require('./google_cloud_translation');
const {
  SemanticBlockService,
  partitionHardBoundaryGroups,
} = require('./semantic_block_service');

const GOOGLE_PROVIDER = 'googleCloudTranslationBasicV2';
const PASS_THROUGH_PROVIDER = 'passthrough';
const MAX_REALTIME_TEXT_CHARACTERS = 5000;
const MAX_FORMAL_SEGMENTS = 500;
const MAX_FORMAL_TEXT_CHARACTERS = 100 * 1000;
const MAX_LABEL_CHARACTERS = 100;
const MAX_IDEMPOTENCY_ENTRIES = 10000;
const IDEMPOTENCY_TTL_MILLISECONDS = 30 * 60 * 1000;
const SOURCE_TEXT_FINGERPRINT_PREFIX = 'sha256-nfc-v1:';
const REUSE_TOKEN_PREFIX = 'mojidas-reuse-v1.';

class MojidasTranslationServiceError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = 'MojidasTranslationServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

class MemoryTranslationIdempotencyStore {
  constructor({
    now = () => Date.now(),
    ttlMilliseconds = IDEMPOTENCY_TTL_MILLISECONDS,
    maxEntries = MAX_IDEMPOTENCY_ENTRIES,
  } = {}) {
    this.now = now;
    this.ttlMilliseconds = ttlMilliseconds;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  async execute({ key, requestFingerprint, operation }) {
    this.removeExpiredEntries();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new MojidasTranslationServiceError(
          'IDEMPOTENCY_CONFLICT',
          '同じ冪等キーが異なる翻訳内容に使用されています。'
        );
      }
      return existing.promise;
    }

    if (this.entries.size >= this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    const promise = Promise.resolve().then(operation);
    this.entries.set(key, {
      requestFingerprint,
      expiresAt: this.now() + this.ttlMilliseconds,
      promise,
    });
    try {
      return await promise;
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }

  removeExpiredEntries() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

class MojidasTranslationService {
  constructor({
    googleTranslation = new GoogleCloudTranslation(),
    semanticBlockService = new SemanticBlockService(),
    idempotencyStore = new MemoryTranslationIdempotencyStore(),
    reuseSecret = process.env.MOJIDAS_TRANSLATION_REUSE_SECRET
      || process.env.MOJIDAS_GOOGLE_TRANSLATION_API_KEY,
  } = {}) {
    this.googleTranslation = googleTranslation;
    this.semanticBlockService = semanticBlockService;
    this.idempotencyStore = idempotencyStore;
    this.reuseSecret = normalizeSecret(reuseSecret);
  }

  async listSupportedLanguages(displayLanguageCode) {
    const normalizedDisplayLanguage = normalizeLanguageCode(displayLanguageCode || 'en');
    if (!normalizedDisplayLanguage) {
      throw invalidRequest('表示言語コードが正しくありません。');
    }
    const languages = canonicalizeTranslationLanguages(
      await this.googleTranslation.listSupportedLanguages(normalizedDisplayLanguage)
    );
    return {
      schemaVersion: 1,
      provider: GOOGLE_PROVIDER,
      displayLanguage: normalizedDisplayLanguage,
      languages,
    };
  }

  async translateRealtime({ userID, request }) {
    const normalizedUserID = normalizeIdentifier(userID);
    const normalized = normalizeRealtimeRequest(request);
    if (!normalizedUserID) throw invalidRequest('ユーザー情報を確認できませんでした。');
    const operationKey = `${normalizedUserID}:realtime:${normalized.idempotencyKey}`;
    const requestFingerprint = stableFingerprint(normalized);

    return this.idempotencyStore.execute({
      key: operationKey,
      requestFingerprint,
      operation: async () => {
        await this.assertSupportedLanguages([
          normalized.sourceLanguageCode,
          normalized.targetLanguageCode,
        ]);
        const isPassThrough = areEquivalentLanguages(
          normalized.sourceLanguageCode,
          normalized.targetLanguageCode
        );
        let translatedText = normalized.text;
        let provider = PASS_THROUGH_PROVIDER;
        if (!isPassThrough) {
          const translations = await this.googleTranslation.translate({
            texts: [normalized.text],
            sourceLanguageCode: googleTranslationLanguageCode(normalized.sourceLanguageCode),
            targetLanguageCode: googleTranslationLanguageCode(normalized.targetLanguageCode),
          });
          if (!Array.isArray(translations) || translations.length !== 1 || !isNonEmptyText(translations[0])) {
            throw invalidGoogleResponse();
          }
          [translatedText] = translations;
          provider = GOOGLE_PROVIDER;
        }
        return {
          sourceTranscriptID: normalized.sourceTranscriptID,
          sourceLanguageCode: normalized.sourceLanguageCode,
          targetLanguageCode: normalized.targetLanguageCode,
          sourceTextFingerprint: normalized.sourceTextFingerprint,
          translatedText,
          isPassThrough,
          provider,
          idempotencyKey: normalized.idempotencyKey,
        };
      },
    });
  }

  async translateFormal({ userID, request }) {
    const normalizedUserID = normalizeIdentifier(userID);
    const normalized = normalizeFormalRequest(request);
    if (!normalizedUserID) throw invalidRequest('ユーザー情報を確認できませんでした。');
    const operationKey = `${normalizedUserID}:formal:${normalized.idempotencyKey}`;
    const requestFingerprint = stableFingerprint(normalized);

    return this.idempotencyStore.execute({
      key: operationKey,
      requestFingerprint,
      operation: async () => {
        await this.assertSupportedLanguages([
          normalized.targetLanguageCode,
          ...new Set(normalized.segments.map((segment) => segment.sourceLanguageCode)),
        ]);
        const segmentBlocks = [];
        for (const hardBoundaryGroup of partitionHardBoundaryGroups(normalized.segments)) {
          if (areEquivalentLanguages(
            hardBoundaryGroup[0].sourceLanguageCode,
            normalized.targetLanguageCode
          )) {
            // 同一言語は翻訳も意味判定も不要。発話単位を保つことで原文を無加工で残す。
            segmentBlocks.push(...hardBoundaryGroup.map((segment) => [segment]));
          } else {
            segmentBlocks.push(...await this.semanticBlockService.groupSegments(hardBoundaryGroup));
          }
        }

        const reusableByKey = new Map(normalized.reusableBlocks.map((block) => [
          reusableBlockKey(block),
          block,
        ]));
        const blocks = segmentBlocks.map((segments) => createFormalBlock({
          segments,
          targetLanguageCode: normalized.targetLanguageCode,
        })).map((block) => applyReusableBlock({
          block,
          userID: normalizedUserID,
          targetLanguageCode: normalized.targetLanguageCode,
          reusableByKey,
          reuseSecret: this.reuseSecret,
        }));
        const billableBySourceLanguage = new Map();
        const billableTranscriptIDs = new Set();
        blocks.forEach((block, index) => {
          if (block.isPassThrough || block.isReused) return;
          const entries = billableBySourceLanguage.get(block.sourceLanguageCode) || [];
          entries.push({ index, text: block.sourceText });
          billableBySourceLanguage.set(block.sourceLanguageCode, entries);
          block.sourceTranscriptIDs.forEach((id) => billableTranscriptIDs.add(id));
        });

        for (const [sourceLanguageCode, entries] of billableBySourceLanguage) {
          const translations = await this.googleTranslation.translate({
            texts: entries.map((entry) => entry.text),
            sourceLanguageCode: googleTranslationLanguageCode(sourceLanguageCode),
            targetLanguageCode: googleTranslationLanguageCode(normalized.targetLanguageCode),
          });
          if (
            !Array.isArray(translations)
            || translations.length !== entries.length
            || translations.some((translation) => !isNonEmptyText(translation))
          ) {
            throw invalidGoogleResponse();
          }
          entries.forEach((entry, resultIndex) => {
            blocks[entry.index].translatedText = translations[resultIndex];
            blocks[entry.index].provider = GOOGLE_PROVIDER;
          });
        }

        const billableMilliseconds = calculateBillableMilliseconds(
          normalized.segments,
          normalized.targetLanguageCode,
          billableTranscriptIDs
        );
        const responseBlocks = blocks.map((block) => ({
          ...block,
          reuseToken: createReuseToken({
            userID: normalizedUserID,
            block,
            targetLanguageCode: normalized.targetLanguageCode,
            reuseSecret: this.reuseSecret,
          }),
        }));
        return {
          sourceSessionID: normalized.sourceSessionID,
          targetLanguageCode: normalized.targetLanguageCode,
          blocks: responseBlocks,
          billableMilliseconds,
          noTranslationRequired: responseBlocks.every((block) => block.isPassThrough),
          reusedBlockCount: responseBlocks.filter((block) => block.isReused).length,
          idempotencyKey: normalized.idempotencyKey,
          // 課金台帳の冪等性照合にだけ使う内部値。API routeで応答から除外する。
          requestFingerprint,
        };
      },
    });
  }

  async assertSupportedLanguages(languageCodes) {
    const languages = await this.googleTranslation.listSupportedLanguages('en');
    if (!Array.isArray(languages)) throw invalidGoogleResponse();
    for (const languageCode of new Set(languageCodes)) {
      const supported = languages.some((language) => (
        language
        && typeof language.code === 'string'
        && areEquivalentLanguageCodesForCatalog(language.code, languageCode)
      ));
      if (!supported) {
        throw new MojidasTranslationServiceError(
          'UNSUPPORTED_TRANSLATION_LANGUAGE',
          '指定された言語はGoogle翻訳で利用できません。'
        );
      }
    }
  }
}

function normalizeRealtimeRequest(request) {
  const requestKeys = [
    'sourceTranscriptID',
    'sourceLanguageCode',
    'targetLanguageCode',
    'text',
    'sourceTextFingerprint',
    'idempotencyKey',
  ];
  if (!hasExactKeys(request, requestKeys)) throw invalidRequest();
  const sourceTranscriptID = normalizeIdentifier(request.sourceTranscriptID);
  const sourceLanguageCode = normalizeLanguageCode(request.sourceLanguageCode);
  const targetLanguageCode = normalizeLanguageCode(request.targetLanguageCode);
  const text = normalizeText(request.text, MAX_REALTIME_TEXT_CHARACTERS);
  const sourceTextFingerprint = normalizeSourceTextFingerprint(request.sourceTextFingerprint);
  const idempotencyKey = normalizeIdentifier(request.idempotencyKey);
  if (
    !sourceTranscriptID
    || !sourceLanguageCode
    || !targetLanguageCode
    || !text
    || !sourceTextFingerprint
    || !idempotencyKey
  ) {
    throw invalidRequest('リアルタイム翻訳の内容が正しくありません。');
  }
  if (sourceTextFingerprint !== textFingerprint(text)) {
    throw new MojidasTranslationServiceError(
      'SOURCE_TEXT_FINGERPRINT_MISMATCH',
      '原文と原文フィンガープリントが一致しません。'
    );
  }
  return {
    sourceTranscriptID,
    sourceLanguageCode,
    targetLanguageCode,
    text,
    sourceTextFingerprint,
    idempotencyKey,
  };
}

function normalizeFormalRequest(request) {
  if (!hasRequiredAndAllowedKeys(request, [
    'sourceSessionID',
    'targetLanguageCode',
    'segments',
    'idempotencyKey',
  ], ['reusableBlocks'])) throw invalidRequest();
  const sourceSessionID = normalizeIdentifier(request.sourceSessionID);
  const targetLanguageCode = normalizeLanguageCode(request.targetLanguageCode);
  const idempotencyKey = normalizeIdentifier(request.idempotencyKey);
  if (
    !sourceSessionID
    || !targetLanguageCode
    || !idempotencyKey
    || !Array.isArray(request.segments)
    || request.segments.length === 0
    || request.segments.length > MAX_FORMAL_SEGMENTS
  ) {
    throw invalidRequest('正式翻訳の内容が正しくありません。');
  }

  const seenIDs = new Set();
  let totalCharacters = 0;
  const segments = request.segments.map((segment) => {
    if (!hasRequiredAndAllowedKeys(segment, [
      'id',
      'inputID',
      'recordingID',
      'sourceLanguageCode',
      'sourceTextFingerprint',
      'startMilliseconds',
      'endMilliseconds',
      'text',
      'label',
      'colorHex',
      'recognitionStartedAt',
    ], ['recognitionRunID'])) throw invalidRequest();
    const id = normalizeIdentifier(segment.id);
    const inputID = normalizeIdentifier(segment.inputID);
    const recordingID = normalizeIdentifier(segment.recordingID);
    const recognitionRunID = segment.recognitionRunID === null || segment.recognitionRunID === undefined
      ? null
      : normalizeIdentifier(segment.recognitionRunID);
    const sourceLanguageCode = normalizeLanguageCode(segment.sourceLanguageCode);
    const text = normalizeText(segment.text, MAX_REALTIME_TEXT_CHARACTERS);
    const sourceTextFingerprint = normalizeSourceTextFingerprint(segment.sourceTextFingerprint);
    const startMilliseconds = normalizeTimelineMilliseconds(segment.startMilliseconds);
    const endMilliseconds = normalizeTimelineMilliseconds(segment.endMilliseconds);
    const label = normalizeLabel(segment.label);
    const colorHex = normalizeColorHex(segment.colorHex);
    const recognitionStartedAt = normalizeOptionalDate(segment.recognitionStartedAt);
    if (
      !id
      || seenIDs.has(id)
      || !inputID
      || !recordingID
      || recognitionRunID === ''
      || !sourceLanguageCode
      || !text
      || !sourceTextFingerprint
      || startMilliseconds === null
      || endMilliseconds === null
      || endMilliseconds < startMilliseconds
      || label === null
      || colorHex === null
      || recognitionStartedAt === undefined
    ) {
      throw invalidRequest('正式翻訳に含まれる発話が正しくありません。');
    }
    if (sourceTextFingerprint !== textFingerprint(text)) {
      throw new MojidasTranslationServiceError(
        'SOURCE_TEXT_FINGERPRINT_MISMATCH',
        `発話${id}の原文と原文フィンガープリントが一致しません。`
      );
    }
    seenIDs.add(id);
    totalCharacters += Array.from(text).length;
    if (totalCharacters > MAX_FORMAL_TEXT_CHARACTERS) {
      throw new MojidasTranslationServiceError(
        'TRANSLATION_INPUT_TOO_LARGE',
        `正式翻訳へ送信できる本文は最大${MAX_FORMAL_TEXT_CHARACTERS}文字です。`
      );
    }
    return {
      id,
      inputID,
      recordingID,
      recognitionRunID,
      sourceLanguageCode,
      sourceTextFingerprint,
      startMilliseconds,
      endMilliseconds,
      text,
      label,
      colorHex,
      recognitionStartedAt,
    };
  });
  const reusableBlocks = normalizeReusableBlocks(
    request.reusableBlocks === undefined ? [] : request.reusableBlocks,
    targetLanguageCode
  );
  return {
    sourceSessionID,
    targetLanguageCode,
    segments,
    reusableBlocks,
    idempotencyKey,
  };
}

function normalizeReusableBlocks(value, targetLanguageCode) {
  if (!Array.isArray(value) || value.length > MAX_FORMAL_SEGMENTS) {
    throw invalidRequest('再利用する翻訳ブロックが正しくありません。');
  }
  const usedKeys = new Set();
  return value.map((block) => {
    if (!hasExactKeys(block, [
      'sourceTranscriptIDs',
      'sourceTextFingerprint',
      'sourceLanguageCode',
      'targetLanguageCode',
      'translatedText',
      'provider',
      'isPassThrough',
      'reuseToken',
    ])) throw invalidRequest('再利用する翻訳ブロックが正しくありません。');
    if (
      !Array.isArray(block.sourceTranscriptIDs)
      || block.sourceTranscriptIDs.length === 0
      || block.sourceTranscriptIDs.length > MAX_FORMAL_SEGMENTS
    ) {
      throw invalidRequest('再利用する翻訳ブロックが正しくありません。');
    }
    const sourceTranscriptIDs = block.sourceTranscriptIDs.map((id) => normalizeIdentifier(id));
    if (sourceTranscriptIDs.some((id) => !id)) {
      throw invalidRequest('再利用する翻訳ブロックの発話IDが正しくありません。');
    }
    const sourceTextFingerprint = normalizeSourceTextFingerprint(block.sourceTextFingerprint);
    const sourceLanguageCode = normalizeLanguageCode(block.sourceLanguageCode);
    const reusableTargetLanguageCode = normalizeLanguageCode(block.targetLanguageCode);
    const translatedText = normalizeText(block.translatedText, 20 * 1000);
    const provider = typeof block.provider === 'string' ? block.provider.trim() : '';
    const isPassThrough = block.isPassThrough;
    const reuseToken = normalizeReuseToken(block.reuseToken);
    if (
      !sourceTextFingerprint
      || !sourceLanguageCode
      || !reusableTargetLanguageCode
      || !areEquivalentLanguages(reusableTargetLanguageCode, targetLanguageCode)
      || !translatedText
      || !reuseToken
      || typeof isPassThrough !== 'boolean'
      || (isPassThrough && provider !== PASS_THROUGH_PROVIDER)
      || (!isPassThrough && provider !== GOOGLE_PROVIDER)
    ) {
      throw invalidRequest('再利用する翻訳ブロックが正しくありません。');
    }
    const normalized = {
      sourceTranscriptIDs,
      sourceTextFingerprint,
      sourceLanguageCode,
      targetLanguageCode: reusableTargetLanguageCode,
      translatedText,
      provider,
      isPassThrough,
      reuseToken,
    };
    const key = reusableBlockKey(normalized);
    if (usedKeys.has(key)) throw invalidRequest('再利用する翻訳ブロックが重複しています。');
    usedKeys.add(key);
    return normalized;
  });
}

function createFormalBlock({ segments, targetLanguageCode }) {
  if (!Array.isArray(segments) || segments.length === 0) throw invalidRequest();
  const first = segments[0];
  const last = segments[segments.length - 1];
  const sourceTranscriptIDs = [...new Set(segments.map((segment) => (
    segment.sourceTranscriptID || segment.id
  )))];
  const sourceText = segments.map((segment, index) => {
    if (index === 0) return segment.text;
    const previous = segments[index - 1];
    const sourceID = segment.sourceTranscriptID || segment.id;
    const previousSourceID = previous.sourceTranscriptID || previous.id;
    return `${sourceID === previousSourceID ? '' : '\n'}${segment.text}`;
  }).join('');
  const isPassThrough = areEquivalentLanguages(first.sourceLanguageCode, targetLanguageCode);
  return {
    sourceTranscriptIDs,
    sourceText,
    sourceTextFingerprint: blockSourceFingerprint({
      sourceTranscriptIDs,
      sourceLanguageCode: first.sourceLanguageCode,
      sourceText,
    }),
    sourceLanguageCode: first.sourceLanguageCode,
    translatedText: isPassThrough ? sourceText : '',
    startMilliseconds: first.startMilliseconds,
    endMilliseconds: last.endMilliseconds,
    inputID: first.inputID,
    recordingID: first.recordingID,
    recognitionRunID: first.recognitionRunID,
    label: first.label,
    colorHex: first.colorHex,
    isPassThrough,
    isReused: false,
    provider: isPassThrough ? PASS_THROUGH_PROVIDER : GOOGLE_PROVIDER,
  };
}

function applyReusableBlock({
  block,
  userID,
  targetLanguageCode,
  reusableByKey,
  reuseSecret,
}) {
  const reusable = reusableByKey.get(reusableBlockKey({
    ...block,
    targetLanguageCode,
  }));
  if (!reusable || reusable.isPassThrough !== block.isPassThrough) return block;
  if (block.isPassThrough && reusable.translatedText !== block.sourceText) return block;
  if (!verifyReuseToken({
    userID,
    block: reusable,
    targetLanguageCode,
    reuseSecret,
  })) return block;
  return {
    ...block,
    translatedText: reusable.translatedText,
    provider: reusable.provider,
    isReused: true,
  };
}

function createReuseToken({ userID, block, targetLanguageCode, reuseSecret }) {
  if (!reuseSecret) return null;
  const payload = reusableAuthorizationPayload({ userID, block, targetLanguageCode });
  const signature = crypto
    .createHmac('sha256', reuseSecret)
    .update(JSON.stringify(payload), 'utf8')
    .digest('base64url');
  return `${REUSE_TOKEN_PREFIX}${signature}`;
}

function verifyReuseToken({ userID, block, targetLanguageCode, reuseSecret }) {
  if (!reuseSecret) return false;
  const supplied = normalizeReuseToken(block.reuseToken);
  if (!supplied) return false;
  const expected = createReuseToken({ userID, block, targetLanguageCode, reuseSecret });
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return suppliedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function reusableAuthorizationPayload({ userID, block, targetLanguageCode }) {
  return {
    version: 1,
    userID,
    // UUID文字列はmacOS(JSONEncoder)とWindows(System.Text.Json)で文字caseが
    // 異なるため、同じsessionをOS間で引き継いでも署名を再利用できる形へ揃える。
    sourceTranscriptIDs: block.sourceTranscriptIDs.map(canonicalIdentifierForSignature),
    sourceTextFingerprint: block.sourceTextFingerprint,
    sourceLanguageCode: canonicalLanguageForPassThrough(block.sourceLanguageCode),
    targetLanguageCode: canonicalLanguageForPassThrough(targetLanguageCode),
    provider: block.provider,
    isPassThrough: Boolean(block.isPassThrough),
    translatedText: String(block.translatedText).normalize('NFC'),
  };
}

function canonicalIdentifierForSignature(value) {
  const normalized = String(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

function reusableBlockKey(block) {
  return JSON.stringify([
    block.sourceTranscriptIDs,
    block.sourceTextFingerprint,
    canonicalLanguageForPassThrough(block.sourceLanguageCode),
    canonicalLanguageForPassThrough(block.targetLanguageCode),
  ]);
}

function calculateBillableMilliseconds(segments, targetLanguageCode, includedTranscriptIDs = null) {
  const intervalsBySource = new Map();
  for (const segment of segments) {
    if (includedTranscriptIDs && !includedTranscriptIDs.has(segment.id)) continue;
    if (areEquivalentLanguages(segment.sourceLanguageCode, targetLanguageCode)) continue;
    const key = JSON.stringify([
      segment.inputID,
      segment.recordingID,
      segment.recognitionRunID,
    ]);
    const intervals = intervalsBySource.get(key) || [];
    intervals.push([segment.startMilliseconds, segment.endMilliseconds]);
    intervalsBySource.set(key, intervals);
  }

  let total = 0;
  for (const intervals of intervalsBySource.values()) {
    intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    let currentStart = null;
    let currentEnd = null;
    for (const [start, end] of intervals) {
      if (currentStart === null) {
        currentStart = start;
        currentEnd = end;
      } else if (start <= currentEnd) {
        currentEnd = Math.max(currentEnd, end);
      } else {
        total += currentEnd - currentStart;
        currentStart = start;
        currentEnd = end;
      }
    }
    if (currentStart !== null) total += currentEnd - currentStart;
  }
  return total;
}

function areEquivalentLanguages(left, right) {
  return canonicalLanguageForPassThrough(left) === canonicalLanguageForPassThrough(right);
}

function areEquivalentLanguageCodesForCatalog(catalogCode, requestedCode) {
  const catalog = String(catalogCode || '').trim().toLowerCase();
  const requested = String(requestedCode || '').trim().toLowerCase();
  const catalogCanonical = canonicalLanguageForPassThrough(catalog);
  const requestedCanonical = canonicalLanguageForPassThrough(requested);
  return catalog === requested
    || (['zh-hans', 'zh-hant'].includes(catalogCanonical)
      && catalogCanonical === requestedCanonical);
}

function canonicalLanguageForPassThrough(value) {
  const normalized = String(value || '').trim().replace(/_/g, '-').toLowerCase();
  if (['zh', 'zh-cn', 'zh-hans', 'zh-sg'].includes(normalized)) return 'zh-hans';
  if (['zh-tw', 'zh-hant', 'zh-hk', 'zh-mo'].includes(normalized)) return 'zh-hant';
  return normalized;
}

function googleTranslationLanguageCode(value) {
  const canonical = canonicalLanguageForPassThrough(value);
  if (canonical === 'zh-hans') return 'zh-CN';
  if (canonical === 'zh-hant') return 'zh-TW';
  return value;
}

function canonicalizeTranslationLanguages(languages) {
  const canonical = [];
  const indexByCode = new Map();
  for (const language of Array.isArray(languages) ? languages : []) {
    const rawCode = normalizeLanguageCode(language && language.code);
    const name = normalizeText(language && language.name, 1000);
    if (!rawCode || !name) continue;
    const normalizedCode = canonicalLanguageForPassThrough(rawCode);
    const code = normalizedCode === 'zh-hans'
      ? 'zh-CN'
      : normalizedCode === 'zh-hant'
        ? 'zh-TW'
        : rawCode;
    const key = normalizedCode.toLowerCase();
    const existingIndex = indexByCode.get(key);
    const entry = { code, name };
    if (existingIndex === undefined) {
      indexByCode.set(key, canonical.length);
      canonical.push(entry);
    } else if (rawCode.toLowerCase() === code.toLowerCase()) {
      canonical[existingIndex] = entry;
    }
  }
  return canonical;
}

function textFingerprint(text) {
  const digest = crypto
    .createHash('sha256')
    .update(String(text).normalize('NFC'), 'utf8')
    .digest('hex');
  return `${SOURCE_TEXT_FINGERPRINT_PREFIX}${digest}`;
}

function blockSourceFingerprint({ sourceText }) {
  return textFingerprint(sourceText);
}

function stableFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
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

function normalizeText(value, maximumCharacters) {
  if (typeof value !== 'string') return '';
  const normalized = value.normalize('NFC');
  const length = Array.from(normalized).length;
  return normalized.trim() && length <= maximumCharacters ? normalized : '';
}

function normalizeSourceTextFingerprint(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  return /^sha256-nfc-v1:[0-9a-f]{64}$/.test(normalized) ? normalized : '';
}

function normalizeReuseToken(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return /^mojidas-reuse-v1\.[A-Za-z0-9_-]{43}$/.test(normalized) ? normalized : '';
}

function normalizeSecret(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTimelineMilliseconds(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 7 * 24 * 60 * 60 * 1000
    ? value
    : null;
}

function normalizeLabel(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return Array.from(normalized).length <= MAX_LABEL_CHARACTERS ? normalized : null;
}

function normalizeColorHex(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  const match = normalized.match(/^#?([0-9a-f]{6})$/i);
  return match ? match[1].toUpperCase() : null;
}

function normalizeOptionalDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function hasRequiredAndAllowedKeys(value, requiredKeys, optionalKeys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  return requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

function isNonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidRequest(message = '翻訳リクエストが正しくありません。') {
  return new MojidasTranslationServiceError('INVALID_TRANSLATION_REQUEST', message);
}

function invalidGoogleResponse() {
  return new MojidasTranslationServiceError(
    'GOOGLE_TRANSLATION_INVALID_RESPONSE',
    'Google翻訳から有効な応答を取得できませんでした。'
  );
}

module.exports = {
  canonicalizeTranslationLanguages,
  GOOGLE_PROVIDER,
  PASS_THROUGH_PROVIDER,
  REUSE_TOKEN_PREFIX,
  SOURCE_TEXT_FINGERPRINT_PREFIX,
  MemoryTranslationIdempotencyStore,
  MojidasTranslationService,
  MojidasTranslationServiceError,
  areEquivalentLanguages,
  blockSourceFingerprint,
  calculateBillableMilliseconds,
  canonicalLanguageForPassThrough,
  googleTranslationLanguageCode,
  normalizeFormalRequest,
  normalizeRealtimeRequest,
  textFingerprint,
  createReuseToken,
  verifyReuseToken,
};
