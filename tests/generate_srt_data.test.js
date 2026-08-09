const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '../public/javascripts/generate_srt_data.js'),
  'utf8',
);
const context = {};

vm.createContext(context);
vm.runInContext(source, context);

function chunk(text, noLineStart = false, preferPreviousLine = false, noLineEnd = false) {
  return { text, noLineStart, preferPreviousLine, noLineEnd };
}

function divide(chunks, target, language = 'ja') {
  return Array.from(context.devideWith(chunks, target, language));
}

assert.deepStrictEqual(
  divide([chunk('１２３４５６７８９０１２３４'), chunk('１２３４５６７８９０'), chunk('１２３４５６')], 15),
  [chunk('１２３４５６７８９０１２３４'), '\n', chunk('１２３４５６７８９０'), chunk('１２３４５６')],
  '中央を超えた位置ではなく、二行の長さが最も近くなる位置で分割する',
);

assert.deepStrictEqual(
  divide([chunk('１２３４５６７８９０１２３４'), chunk('１２', true), chunk('１２３４５６７８９０１２３４')], 15),
  [chunk('１２３４５６７８９０１２３４'), chunk('１２', true), '\n', chunk('１２３４５６７８９０１２３４')],
  '二行目の先頭に置けない要素の直前では分割しない',
);

assert.deepStrictEqual(
  divide([chunk('１２３４５６７８９０')], 5),
  [chunk('１２３４５６７８９０')],
  '分割可能な境界がない場合は改行を追加しない',
);

assert.deepStrictEqual(
  divide([chunk('１２３４５６７８'), chunk('１２３４５６７８')], 15),
  [chunk('１２３４５６７８'), '\n', chunk('１２３４５６７８')],
  '15文字を超える字幕は二行にする',
);

function generateContent(chunks) {
  const lines = [{
    startTime: 0,
    endTime: 10,
    content: chunks,
    translation: '',
  }];

  return context.generateResult(lines, false, 'ja', (
    num,
    begin,
    end,
    content,
  ) => content);
}

function generateContents(chunks) {
  const contents = [];
  const lines = [{
    startTime: 0,
    endTime: 10,
    content: chunks,
    translation: '',
  }];

  context.generateResult(lines, false, 'ja', (
    num,
    begin,
    end,
    content,
  ) => {
    contents.push(content);
    return '';
  });

  return contents;
}

assert.strictEqual(
  generateContent([chunk('１２３４５６７８９０１２３４'), chunk('１２３４５６７８９０'), chunk('１２３４５６')]),
  '１２３４５６７８９０１２３４\n１２３４５６７８９０１２３４５６',
  'SRT生成時は字幕全体の中央に最も近い境界で二行にする',
);

assert.strictEqual(
  generateContent([chunk('１２３４５'), chunk('１２３４５')]),
  '１２３４５１２３４５',
  '短い字幕は二行にしない',
);

assert.strictEqual(
  generateContent([
    chunk('Nerima '),
    chunk('Base', false, true),
    chunk('の', true),
    chunk('青木'),
    chunk('です', true),
  ]),
  'Nerima Baseの青木です',
  '半角英数字を0.5文字で数え、15文字以内の字幕は一行に保つ',
);

assert.strictEqual(
  generateContent([
    chunk('abcdefghijklmnopqrst '),
    chunk('uvwxyzABCDEFGHIJKLMN', false, true),
    chunk('です', true),
  ]),
  'abcdefghijklmnopqrst\nuvwxyzABCDEFGHIJKLMNです',
  '英語部分を同じ行に収められない場合は英単語間での改行を許可する',
);

assert.strictEqual(
  context.contentLayoutLengthFromArray([chunk('abc123あ')]),
  4,
  '半角英数字は0.5文字、それ以外は1文字として表示長を計算する',
);

assert.strictEqual(
  generateContent([
    chunk('関連'),
    chunk('関係'),
    chunk('あれ'),
    chunk('が', true),
    chunk('なん'),
    chunk('か', true),
    chunk('ちょっともういつなんだろうみたいな'),
  ]),
  '関連関係あれがなんか\nちょっともういつなんだろうみたいな',
  '小書き仮名を含む音節の途中では改行しない',
);

assert.deepStrictEqual(
  divide([
    chunk('１２３４５６７８９０１２３４'),
    chunk('ー続く'),
    chunk('後半'),
  ], 15),
  [
    chunk('１２３４５６７８９０１２３４'),
    chunk('ー続く'),
    '\n',
    chunk('後半'),
  ],
  '長音記号で始まるチャンクの直前では改行しない',
);

assert.deepStrictEqual(
  divide([
    chunk('１２３４５６７８９０１２３４'),
    chunk('やっ', false, false, true),
    chunk('ぱいっぱい'),
  ], 15),
  [
    chunk('１２３４５６７８９０１２３４'),
    '\n',
    chunk('やっ', false, false, true),
    chunk('ぱいっぱい'),
  ],
  '小書き仮名で終わるチャンクの直後では改行しない',
);

assert.deepStrictEqual(
  Array.from(context.divideIntoSubtitleBlocks([
    chunk('１２３４５６７８９０１２３４５６７８９０１２３４５６７'),
    chunk('やっ', false, false, true),
    chunk('ぱいっぱい'),
  ], 30, 'ja'), block => Array.from(block)),
  [
    [chunk('１２３４５６７８９０１２３４５６７８９０１２３４５６７')],
    [chunk('やっ', false, false, true), chunk('ぱいっぱい')],
  ],
  '字幕ブロック境界では小書き仮名で終わるチャンクを次へ送る',
);

assert.deepStrictEqual(
  generateContents([
    chunk('あれ'),
    chunk('の', true),
    chunk('字幕'),
    chunk('翻訳'),
    chunk('を', true),
    chunk('し', true),
    chunk('た', true),
    chunk('方'),
    chunk('が', true),
    chunk('練馬'),
    chunk('の', true),
    chunk('光が丘'),
    chunk('に', true),
    chunk('いらっしゃっ', false, false, true),
    chunk('て ', true),
    chunk('前'),
    chunk('も', true),
    chunk('一'),
    chunk('度'),
  ]),
  ['あれの字幕翻訳をした方が練馬の\n光が丘にいらっしゃって 前も一度'],
  '30文字をわずかに超える場合は一文字だけの字幕ブロックを作らない',
);

function generateBlocks(chunks, replacingDots = false) {
  const lines = [{
    startTime: 0,
    endTime: 10,
    content: chunks,
    translation: '',
  }];

  return context.generateResult(
    lines,
    replacingDots,
    'ja',
    (num, begin, end, content) => `${content}|`,
  );
}

assert.strictEqual(
  generateBlocks([chunk('最初です！'), chunk('次です？'), chunk('最後です。')]),
  '最初です！|次です？|最後です。|',
  '全角の感嘆符と疑問符を句点と同じ字幕終了記号として扱う',
);

assert.strictEqual(
  generateBlocks([chunk('First!'), chunk('Second?')]),
  'First!|Second?|',
  '半角の感嘆符と疑問符も字幕終了記号として扱う',
);

assert.strictEqual(
  generateBlocks([chunk('First.'), chunk('Second!')]),
  'First.|Second!|',
  '英語の半角ピリオドを字幕終了記号として扱い、文字として残す',
);

assert.strictEqual(
  generateBlocks([chunk('本当！？'), chunk('次です。')]),
  '本当！？|次です。|',
  '連続する字幕終了記号では字幕を一度だけ分割する',
);

assert.strictEqual(
  generateBlocks([chunk('本当！？'), chunk('次、です。')], true),
  '本当！？|次 です|',
  '句読点変換では句点と読点だけを変換し、疑問符と感嘆符を残す',
);

const exampleTokens = [
  chunk('次'),
  chunk('は', true),
  chunk('9'),
  chunk('月'),
  chunk('って', true),
  chunk('おっしゃっ'),
  chunk('て', true),
  chunk('た', true),
  chunk('か', true),
  chunk('な', true),
  chunk('なんか'),
  chunk('ジブリ'),
  chunk('映画'),
  chunk('らしい', true),
  chunk('ので', true),
  chunk('あんまり'),
  chunk('宣伝'),
  chunk('を', true),
];

assert.strictEqual(
  generateBlocks(exampleTokens),
  '次は9月っておっしゃってたかな\nなんかジブリ映画らしいので|あんまり宣伝を|',
  '一行15文字、二行30文字を基準に単語境界で字幕を分割する',
);

const timings = [];
context.generateResult([{
  startTime: 0,
  endTime: 35,
  content: exampleTokens,
  translation: '',
}], false, 'ja', (num, begin, end) => {
  timings.push([begin, end]);
  return '';
});

assert.deepStrictEqual(
  timings,
  [[0, 28], [28, 35]],
  '字幕を分割した時間は従来どおり元テキストの文字数比率で配分する',
);

function generateContentsWithSettings(chunks, maxLengthPerLine, maxLines) {
  const contents = [];
  const lines = [{
    startTime: 0,
    endTime: 16,
    content: chunks,
    translation: '',
  }];

  context.generateResult(lines, false, 'ja', (num, begin, end, content) => {
    contents.push({ content, begin, end });
    return '';
  }, maxLengthPerLine, maxLines);

  return contents;
}

assert.deepStrictEqual(
  generateContentsWithSettings([
    chunk('１２３４５'),
    chunk('６７８９０'),
    chunk('１２３４５'),
    chunk('６７８９０'),
  ], 15, 1),
  [
    { content: '１２３４５６７８９０', begin: 0, end: 8 },
    { content: '１２３４５６７８９０', begin: 8, end: 16 },
  ],
  '一行を選択した場合は従来の改行位置で別の字幕データへ分割する',
);

assert.deepStrictEqual(
  generateContentsWithSettings([
    chunk('１２３４５'),
    chunk('６７８９０'),
    chunk('１２３４５'),
    chunk('６７８９０'),
  ], 15, 2),
  [{ content: '１２３４５６７８９０\n１２３４５６７８９０', begin: 0, end: 16 }],
  '二行を選択した場合は指定文字数を基準に一つの字幕データ内で改行する',
);

const validTimeContents = [];
context.generateResult([
  {
    startTime: 0,
    endTime: 0,
    content: [chunk('表示時間がありません')],
    translation: '',
  },
  {
    startTime: 2,
    endTime: 1,
    content: [chunk('終了時刻が開始時刻より前です')],
    translation: '',
  },
  {
    startTime: 1,
    endTime: 2,
    content: [chunk('正常な字幕です')],
    translation: '',
  },
], false, 'ja', (num, begin, end, content) => {
  validTimeContents.push(content);
  return '';
});

assert.deepStrictEqual(
  validTimeContents,
  ['正常な字幕です'],
  '終了時刻が開始時刻以前の字幕はSRTデータから除外する',
);

console.log('generate_srt_data.js: 24件のテストに成功しました。');
