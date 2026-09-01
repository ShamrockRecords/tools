const assert = require('assert');

const {
  DEFAULT_API_BODY_LIMIT,
  DEFAULT_MAX_SEGMENTS,
  DEFAULT_MAX_TEXT_CHARACTERS,
  resolveMojidasApiBodyLimit,
  resolveMojidasTranslationLimits,
} = require('../modules/config/mojidas_translation_config');

function main() {
  assert.deepStrictEqual(resolveMojidasTranslationLimits({ environment: {} }), {
    maxSegments: DEFAULT_MAX_SEGMENTS,
    maxTextCharacters: DEFAULT_MAX_TEXT_CHARACTERS,
  });
  assert.deepStrictEqual(resolveMojidasTranslationLimits({
    maxSegments: 3000,
    maxTextCharacters: 250000,
    environment: {},
  }), {
    maxSegments: 3000,
    maxTextCharacters: 250000,
  });
  assert.deepStrictEqual(resolveMojidasTranslationLimits({
    environment: {
      MOJIDAS_TRANSLATION_MAX_SEGMENTS: '4000',
      MOJIDAS_TRANSLATION_MAX_TEXT_CHARACTERS: '500000',
    },
  }), {
    maxSegments: 4000,
    maxTextCharacters: 500000,
  });
  assert.throws(
    () => resolveMojidasTranslationLimits({ maxSegments: 10001, environment: {} }),
    /MOJIDAS_TRANSLATION_MAX_SEGMENTS/
  );
  assert.throws(
    () => resolveMojidasTranslationLimits({ maxTextCharacters: 'invalid', environment: {} }),
    /MOJIDAS_TRANSLATION_MAX_TEXT_CHARACTERS/
  );

  assert.strictEqual(resolveMojidasApiBodyLimit({ environment: {} }), DEFAULT_API_BODY_LIMIT);
  assert.strictEqual(resolveMojidasApiBodyLimit({ bodyLimit: '5MB' }), '5mb');
  assert.strictEqual(resolveMojidasApiBodyLimit({
    environment: { MOJIDAS_API_BODY_LIMIT: '512kb' },
  }), '512kb');
  assert.throws(
    () => resolveMojidasApiBodyLimit({ bodyLimit: '32mb' }),
    /MOJIDAS_API_BODY_LIMIT/
  );
  assert.throws(
    () => resolveMojidasApiBodyLimit({ bodyLimit: '3000000' }),
    /MOJIDAS_API_BODY_LIMIT/
  );

  console.log('Mojidas translation config tests passed');
}

main();
