const DEFAULT_MAX_SEGMENTS = 2000;
const DEFAULT_MAX_TEXT_CHARACTERS = 100 * 1000;
const DEFAULT_API_BODY_LIMIT = '3mb';

const MIN_MAX_SEGMENTS = 1;
const MAX_MAX_SEGMENTS = 10000;
const MIN_MAX_TEXT_CHARACTERS = 1000;
const MAX_MAX_TEXT_CHARACTERS = 1000 * 1000;
const MIN_API_BODY_BYTES = 64 * 1024;
const MAX_API_BODY_BYTES = 25 * 1024 * 1024;

function resolveMojidasTranslationLimits({
  maxSegments,
  maxTextCharacters,
  environment = process.env,
} = {}) {
  return {
    maxSegments: normalizeIntegerSetting(
      maxSegments ?? environment.MOJIDAS_TRANSLATION_MAX_SEGMENTS,
      DEFAULT_MAX_SEGMENTS,
      MIN_MAX_SEGMENTS,
      MAX_MAX_SEGMENTS,
      'MOJIDAS_TRANSLATION_MAX_SEGMENTS'
    ),
    maxTextCharacters: normalizeIntegerSetting(
      maxTextCharacters ?? environment.MOJIDAS_TRANSLATION_MAX_TEXT_CHARACTERS,
      DEFAULT_MAX_TEXT_CHARACTERS,
      MIN_MAX_TEXT_CHARACTERS,
      MAX_MAX_TEXT_CHARACTERS,
      'MOJIDAS_TRANSLATION_MAX_TEXT_CHARACTERS'
    ),
  };
}

function resolveMojidasApiBodyLimit({
  bodyLimit,
  environment = process.env,
} = {}) {
  const value = bodyLimit ?? environment.MOJIDAS_API_BODY_LIMIT;
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_API_BODY_LIMIT;
  }
  const normalized = String(value).trim().toLowerCase();
  const match = normalized.match(/^([1-9]\d*)(kb|mb)$/);
  if (!match) {
    throw configurationError(
      'MOJIDAS_API_BODY_LIMIT',
      '64kb〜25mbの範囲でkbまたはmb単位を指定してください。'
    );
  }
  const multiplier = match[2] === 'mb' ? 1024 * 1024 : 1024;
  const bytes = Number(match[1]) * multiplier;
  if (bytes < MIN_API_BODY_BYTES || bytes > MAX_API_BODY_BYTES) {
    throw configurationError(
      'MOJIDAS_API_BODY_LIMIT',
      '64kb〜25mbの範囲で指定してください。'
    );
  }
  return normalized;
}

function normalizeIntegerSetting(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw configurationError(name, `${minimum}〜${maximum}の整数で指定してください。`);
  }
  return parsed;
}

function configurationError(name, requirement) {
  return new RangeError(`${name}は${requirement}`);
}

module.exports = {
  DEFAULT_API_BODY_LIMIT,
  DEFAULT_MAX_SEGMENTS,
  DEFAULT_MAX_TEXT_CHARACTERS,
  resolveMojidasApiBodyLimit,
  resolveMojidasTranslationLimits,
};
