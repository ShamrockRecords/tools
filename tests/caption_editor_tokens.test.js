const assert = require('assert');
const createSubtitleChunks = require('../modules/captionEditor/createSubtitleChunks');

function token(surface, pos = '名詞') {
  return {
    surface_form: surface,
    pos: pos,
  };
}

assert.deepStrictEqual(
  createSubtitleChunks([
    token('本当'),
    token('！', '記号'),
    token('？', '記号'),
    token('次'),
    token('です', '助動詞'),
    token('。', '記号'),
  ]),
  [
    { text: '本当！？', noLineStart: false },
    { text: '次', noLineStart: false },
    { text: 'です。', noLineStart: true },
  ],
  '連続する字幕終了記号を直前の単語にまとめる',
);

assert.deepStrictEqual(
  createSubtitleChunks([
    token('Hello'),
    token('.', '記号'),
    token(' ', '記号'),
    token('world'),
    token('!', '記号'),
  ]),
  [
    { text: 'Hello. ', noLineStart: false },
    { text: 'world!', noLineStart: false },
  ],
  '英語の空白と終了記号を直前の単語にまとめる',
);

assert.deepStrictEqual(
  createSubtitleChunks([
    token('映画'),
    token('を', '助詞'),
    token('見る'),
  ]),
  [
    { text: '映画', noLineStart: false },
    { text: 'を', noLineStart: true },
    { text: '見る', noLineStart: false },
  ],
  '助詞を単語単位で保持し、行頭禁止として記録する',
);

console.log('createSubtitleChunks.js: 3件のテストに成功しました。');
