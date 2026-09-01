const https = require('https');
const { TextDecoder } = require('util');

const DEFAULT_BASE_URL = 'https://translation.googleapis.com';
const TRANSLATE_PATH = '/language/translate/v2';
const LANGUAGES_PATH = '/language/translate/v2/languages';
const REQUEST_TIMEOUT_MILLISECONDS = 10000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TEXTS_PER_REQUEST = 128;
const MAX_CODE_POINTS_PER_REQUEST = 5000;
const MAX_CONCURRENT_TRANSLATION_REQUESTS = 4;
const DEFAULT_LANGUAGE_CACHE_TTL_MILLISECONDS = 24 * 60 * 60 * 1000;
const DEFAULT_LANGUAGE_CACHE_STALE_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

class GoogleCloudTranslationError extends Error {
  constructor(code, message, { statusCode, cause } = {}) {
    super(message);
    this.name = 'GoogleCloudTranslationError';
    this.code = code;
    if (Number.isInteger(statusCode)) this.statusCode = statusCode;
    if (cause) this.cause = cause;
  }
}

class GoogleCloudTranslation {
  constructor({
    apiKey = process.env.MOJIDAS_GOOGLE_TRANSLATION_API_KEY,
    baseURL = DEFAULT_BASE_URL,
    requester = requestJson,
    requestTimeoutMilliseconds = REQUEST_TIMEOUT_MILLISECONDS,
    maxResponseBytes = MAX_RESPONSE_BYTES,
    languageCacheTtlMilliseconds = DEFAULT_LANGUAGE_CACHE_TTL_MILLISECONDS,
    languageCacheStaleMilliseconds = DEFAULT_LANGUAGE_CACHE_STALE_MILLISECONDS,
    now = () => Date.now(),
  } = {}) {
    this.apiKey = normalizeString(apiKey);
    this.baseURL = baseURL;
    this.requester = requester;
    this.requestTimeoutMilliseconds = normalizePositiveInteger(
      requestTimeoutMilliseconds,
      REQUEST_TIMEOUT_MILLISECONDS
    );
    this.maxResponseBytes = normalizePositiveInteger(maxResponseBytes, MAX_RESPONSE_BYTES);
    this.languageCacheTtlMilliseconds = normalizeNonNegativeInteger(
      languageCacheTtlMilliseconds,
      DEFAULT_LANGUAGE_CACHE_TTL_MILLISECONDS
    );
    this.languageCacheStaleMilliseconds = normalizeNonNegativeInteger(
      languageCacheStaleMilliseconds,
      DEFAULT_LANGUAGE_CACHE_STALE_MILLISECONDS
    );
    this.now = now;
    this.languageCache = new Map();
  }

  async listSupportedLanguages(displayLanguageCode = 'ja') {
    const normalizedDisplayLanguageCode = normalizeLanguageCode(displayLanguageCode);
    if (!normalizedDisplayLanguageCode) {
      throw invalidRequest('表示言語コードが正しくありません。');
    }

    const cacheKey = normalizedDisplayLanguageCode.toLowerCase();
    const currentTime = this._currentTime();
    const cached = this.languageCache.get(cacheKey);
    const cacheAge = cached ? Math.max(0, currentTime - cached.loadedAt) : Infinity;
    if (cached && cacheAge <= this.languageCacheTtlMilliseconds) {
      return cloneLanguages(cached.languages);
    }

    try {
      const url = new URL(LANGUAGES_PATH, this.baseURL);
      url.searchParams.set('target', normalizedDisplayLanguageCode);
      url.searchParams.set('model', 'nmt');
      const payload = await this._requestJSON({
        method: 'GET',
        url: url.toString(),
      });
      const languages = parseLanguages(payload);
      this.languageCache.set(cacheKey, {
        loadedAt: currentTime,
        languages,
      });
      return cloneLanguages(languages);
    } catch (error) {
      const maximumStaleAge = this.languageCacheTtlMilliseconds
        + this.languageCacheStaleMilliseconds;
      if (cached && cacheAge <= maximumStaleAge) {
        return cloneLanguages(cached.languages);
      }
      throw normalizeRequestError(error);
    }
  }

  async translate({ texts, sourceLanguageCode, targetLanguageCode } = {}) {
    const normalizedSourceLanguageCode = normalizeLanguageCode(sourceLanguageCode);
    const normalizedTargetLanguageCode = normalizeLanguageCode(targetLanguageCode);
    if (!normalizedSourceLanguageCode || !normalizedTargetLanguageCode) {
      throw invalidRequest('翻訳元または翻訳先の言語コードが正しくありません。');
    }

    const batches = buildTranslationBatches(texts);
    const batchTranslations = await executeWithConcurrency(
      batches.map((batch) => async () => {
        const payload = await this._requestJSON({
          method: 'POST',
          url: new URL(TRANSLATE_PATH, this.baseURL).toString(),
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            q: batch,
            source: normalizedSourceLanguageCode,
            target: normalizedTargetLanguageCode,
            format: 'text',
          }),
        });
        return parseTranslations(payload, batch.length);
      }),
      MAX_CONCURRENT_TRANSLATION_REQUESTS
    );
    return batchTranslations.flat();
  }

  async _requestJSON({ method, url, headers = {}, body }) {
    if (!this.apiKey) {
      throw new GoogleCloudTranslationError(
        'GOOGLE_TRANSLATION_NOT_CONFIGURED',
        'Google Cloud Translationの設定が完了していません。'
      );
    }

    let response;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.requester({
          method,
          url,
          headers: {
            Accept: 'application/json',
            'x-goog-api-key': this.apiKey,
            ...headers,
          },
          body,
          timeoutMilliseconds: this.requestTimeoutMilliseconds,
          maxResponseBytes: this.maxResponseBytes,
        });
      } catch (error) {
        const normalized = normalizeRequestError(error);
        if (attempt === 0 && isRetryableGoogleError(normalized)) continue;
        throw normalized;
      }

      if (!response || !Number.isInteger(response.statusCode)) {
        throw invalidResponse('Google Cloud Translationから不正な応答を受信しました。');
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const requestError = new GoogleCloudTranslationError(
          response.statusCode === 429
            ? 'GOOGLE_TRANSLATION_RATE_LIMITED'
            : 'GOOGLE_TRANSLATION_REQUEST_FAILED',
          'Google Cloud Translationへのリクエストに失敗しました。',
          { statusCode: response.statusCode }
        );
        if (attempt === 0 && isRetryableGoogleError(requestError)) continue;
        throw requestError;
      }
      break;
    }

    let rawBody;
    if (Buffer.isBuffer(response.body)) {
      try {
        rawBody = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
      } catch (error) {
        throw invalidResponse('Google Cloud TranslationからUTF-8以外の応答を受信しました。');
      }
    } else {
      rawBody = response.body;
    }
    if (typeof rawBody !== 'string') {
      throw invalidResponse('Google Cloud Translationから不正な応答を受信しました。');
    }
    if (Buffer.byteLength(rawBody) > this.maxResponseBytes) {
      throw new GoogleCloudTranslationError(
        'GOOGLE_TRANSLATION_RESPONSE_TOO_LARGE',
        'Google Cloud Translationからの応答サイズが上限を超えました。'
      );
    }

    try {
      return JSON.parse(rawBody);
    } catch (error) {
      throw invalidResponse('Google Cloud TranslationからJSON以外の応答を受信しました。');
    }
  }

  _currentTime() {
    const value = Number(this.now());
    return Number.isFinite(value) ? value : Date.now();
  }
}

async function executeWithConcurrency(operations, maximumConcurrency) {
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

function buildTranslationBatches(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw invalidRequest('翻訳するテキストを1件以上指定してください。');
  }

  const normalizedTexts = texts.map((text) => {
    if (typeof text !== 'string' || !text.trim()) {
      throw invalidRequest('空のテキストは翻訳できません。');
    }
    const codePointLength = countCodePoints(text);
    if (codePointLength > MAX_CODE_POINTS_PER_REQUEST) {
      throw new GoogleCloudTranslationError(
        'TRANSLATION_TEXT_TOO_LONG',
        `1件のテキストは${MAX_CODE_POINTS_PER_REQUEST}コードポイント以下にしてください。`
      );
    }
    return { text, codePointLength };
  });

  const batches = [];
  let currentBatch = [];
  let currentCodePoints = 0;
  for (const item of normalizedTexts) {
    if (currentBatch.length > 0
      && (currentBatch.length >= MAX_TEXTS_PER_REQUEST
        || currentCodePoints + item.codePointLength > MAX_CODE_POINTS_PER_REQUEST)) {
      batches.push(currentBatch);
      currentBatch = [];
      currentCodePoints = 0;
    }
    currentBatch.push(item.text);
    currentCodePoints += item.codePointLength;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);
  return batches;
}

function parseLanguages(payload) {
  const rawLanguages = payload && payload.data && payload.data.languages;
  if (!Array.isArray(rawLanguages) || rawLanguages.length === 0 || rawLanguages.length > 1000) {
    throw invalidResponse('Google Cloud Translationから言語一覧を取得できませんでした。');
  }

  const seen = new Set();
  return rawLanguages.map((item) => {
    const code = normalizeLanguageCode(item && item.language);
    const name = normalizeString(item && item.name);
    const normalizedCode = code && code.toLowerCase();
    if (!code || !name || seen.has(normalizedCode)) {
      throw invalidResponse('Google Cloud Translationの言語一覧が正しくありません。');
    }
    seen.add(normalizedCode);
    return { code, name };
  });
}

function parseTranslations(payload, expectedCount) {
  const rawTranslations = payload && payload.data && payload.data.translations;
  if (!Array.isArray(rawTranslations) || rawTranslations.length !== expectedCount) {
    throw invalidResponse('Google Cloud Translationの翻訳件数が一致しません。');
  }
  return rawTranslations.map((item) => {
    const translatedText = item && item.translatedText;
    if (typeof translatedText !== 'string' || !translatedText.trim()) {
      throw invalidResponse('Google Cloud Translationから空の翻訳結果を受信しました。');
    }
    const decodedText = decodeHTMLEntities(translatedText);
    const compactedText = compactTranslationText(decodedText);
    if (!compactedText) {
      throw invalidResponse('Google Cloud Translationから空の翻訳結果を受信しました。');
    }
    return compactedText;
  });
}

function compactTranslationText(value) {
  return String(value)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function decodeHTMLEntities(value) {
  return value.replace(
    /&(amp|lt|gt|quot|apos|#39|#\d+|#x[0-9a-f]+);/gi,
    (match, entity) => {
      const normalized = entity.toLowerCase();
      const named = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        '#39': "'",
      };
      if (Object.prototype.hasOwnProperty.call(named, normalized)) return named[normalized];
      const codePoint = normalized.startsWith('#x')
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      if (
        !Number.isInteger(codePoint)
        || codePoint < 0
        || codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return match;
      }
      return String.fromCodePoint(codePoint);
    }
  );
}

function requestJson({
  method,
  url,
  headers = {},
  body,
  timeoutMilliseconds = REQUEST_TIMEOUT_MILLISECONDS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const requestHeaders = { ...headers };
    if (body !== undefined) {
      requestHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const request = https.request(url, {
      method,
      headers: requestHeaders,
    }, (response) => {
      const declaredLength = Number(response.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        response.destroy();
        fail(new GoogleCloudTranslationError(
          'GOOGLE_TRANSLATION_RESPONSE_TOO_LARGE',
          'Google Cloud Translationからの応答サイズが上限を超えました。'
        ));
        return;
      }

      const chunks = [];
      let responseBytes = 0;
      response.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseBytes += buffer.length;
        if (responseBytes > maxResponseBytes) {
          response.destroy();
          fail(new GoogleCloudTranslationError(
            'GOOGLE_TRANSLATION_RESPONSE_TOO_LARGE',
            'Google Cloud Translationからの応答サイズが上限を超えました。'
          ));
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          statusCode: response.statusCode || 0,
          body: Buffer.concat(chunks),
        });
      });
      response.on('error', (error) => fail(new GoogleCloudTranslationError(
        'GOOGLE_TRANSLATION_REQUEST_FAILED',
        'Google Cloud Translationからの応答を受信できませんでした。',
        { cause: error }
      )));
    });

    request.setTimeout(timeoutMilliseconds, () => {
      fail(new GoogleCloudTranslationError(
        'GOOGLE_TRANSLATION_TIMEOUT',
        'Google Cloud Translationへのリクエストがタイムアウトしました。'
      ));
      request.destroy();
    });
    request.on('error', (error) => fail(new GoogleCloudTranslationError(
      'GOOGLE_TRANSLATION_REQUEST_FAILED',
      'Google Cloud Translationへ接続できませんでした。',
      { cause: error }
    )));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function normalizeRequestError(error) {
  if (error instanceof GoogleCloudTranslationError) return error;
  return new GoogleCloudTranslationError(
    'GOOGLE_TRANSLATION_REQUEST_FAILED',
    'Google Cloud Translationへ接続できませんでした。',
    { cause: error }
  );
}

function isRetryableGoogleError(error) {
  if (!error) return false;
  if (error.code === 'GOOGLE_TRANSLATION_TIMEOUT') return true;
  if (error.code === 'GOOGLE_TRANSLATION_RATE_LIMITED') return true;
  if (error.code !== 'GOOGLE_TRANSLATION_REQUEST_FAILED') return false;
  return !Number.isInteger(error.statusCode)
    || error.statusCode === 429
    || error.statusCode >= 500;
}

function invalidRequest(message) {
  return new GoogleCloudTranslationError('INVALID_TRANSLATION_REQUEST', message);
}

function invalidResponse(message) {
  return new GoogleCloudTranslationError('GOOGLE_TRANSLATION_INVALID_RESPONSE', message);
}

function normalizeLanguageCode(value) {
  const normalized = normalizeString(value);
  if (!normalized || normalized.length > 64) return '';
  return /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/.test(normalized) ? normalized : '';
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function countCodePoints(value) {
  return Array.from(value).length;
}

function cloneLanguages(languages) {
  return languages.map(({ code, name }) => ({ code, name }));
}

module.exports = {
  compactTranslationText,
  GoogleCloudTranslation,
  GoogleCloudTranslationError,
  buildTranslationBatches,
  decodeHTMLEntities,
  requestJson,
  DEFAULT_BASE_URL,
  MAX_TEXTS_PER_REQUEST,
  MAX_CODE_POINTS_PER_REQUEST,
};
