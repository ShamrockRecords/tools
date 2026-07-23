const assert = require('assert');
const createSubtitleChunks = require('../modules/captionEditor/createSubtitleChunks');

function token(surface, pos = '名詞', posDetail = '一般') {
  return {
    surface_form: surface,
    pos: pos,
    pos_detail_1: posDetail,
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

assert.deepStrictEqual(
  createSubtitleChunks([
    token('Nerima'),
    token(' ', '記号'),
    token('Base'),
    token('の', '助詞'),
    token('青木'),
    token('です', '助動詞'),
  ]),
  [
    { text: 'Nerima ', noLineStart: false },
    { text: 'Base', noLineStart: false, preferPreviousLine: true },
    { text: 'の', noLineStart: true },
    { text: '青木', noLineStart: false },
    { text: 'です', noLineStart: true },
  ],
  '空白で連続する英単語を同じ行に置く候補として記録する',
);

assert.deepStrictEqual(
  createSubtitleChunks([
    token('ご', '接頭詞', '名詞接続'),
    token('希望', '名詞', 'サ変接続'),
    token('の', '助詞', '連体化'),
    token('方', '名詞', '非自立'),
    token('は', '助詞', '係助詞'),
    token('お', '接頭詞', '名詞接続'),
    token('名前'),
    token('を', '助詞', '格助詞'),
    token('ご', '接頭詞', '名詞接続'),
    token('確認', '名詞', 'サ変接続'),
  ]),
  [
    { text: 'ご希望', noLineStart: false },
    { text: 'の', noLineStart: true },
    { text: '方', noLineStart: false },
    { text: 'は', noLineStart: true },
    { text: 'お名前', noLineStart: false },
    { text: 'を', noLineStart: true },
    { text: 'ご確認', noLineStart: false },
  ],
  '名詞接続の接頭詞を直後の名詞と一つの字幕チャンクにまとめる',
);

assert.deepStrictEqual(
  createSubtitleChunks([
    token('かち', '動詞', '自立'),
    token('ょっともういつなんだろうみたいな'),
  ]),
  [
    { text: 'か', noLineStart: true },
    { text: 'ちょっともういつなんだろうみたいな', noLineStart: false },
  ],
  '小書き仮名と直前の仮名を同じチャンクへ補正する',
);

assert.deepStrictEqual(
  createSubtitleChunks([
    token('ー続く'),
    token('々続く'),
    token('ゝ続く'),
    token('ゞ続く'),
    token('ヽ続く'),
    token('ヾ続く'),
    token('゛続く'),
    token('゜続く'),
  ]),
  [
    { text: 'ー続く', noLineStart: true },
    { text: '々続く', noLineStart: true },
    { text: 'ゝ続く', noLineStart: true },
    { text: 'ゞ続く', noLineStart: true },
    { text: 'ヽ続く', noLineStart: true },
    { text: 'ヾ続く', noLineStart: true },
    { text: '゛続く', noLineStart: true },
    { text: '゜続く', noLineStart: true },
  ],
  '長音・繰り返し・濁点記号で始まるチャンクを行頭禁止にする',
);

console.log('createSubtitleChunks.js: 7件のテストに成功しました。');
