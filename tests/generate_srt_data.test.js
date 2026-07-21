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

function chunk(text, noLineStart = false) {
  return { text, noLineStart };
}

function divide(chunks, target, language = 'ja') {
  return Array.from(context.devideWith(chunks, target, language));
}

assert.deepStrictEqual(
  divide([chunk('12345678901234'), chunk('1234567890'), chunk('123456')], 15),
  [chunk('12345678901234'), '\n', chunk('1234567890'), chunk('123456')],
  '中央を超えた位置ではなく、二行の長さが最も近くなる位置で分割する',
);

assert.deepStrictEqual(
  divide([chunk('12345678901234'), chunk('12', true), chunk('12345678901234')], 15),
  [chunk('12345678901234'), chunk('12', true), '\n', chunk('12345678901234')],
  '二行目の先頭に置けない要素の直前では分割しない',
);

assert.deepStrictEqual(
  divide([chunk('1234567890')], 5),
  [chunk('1234567890')],
  '分割可能な境界がない場合は改行を追加しない',
);

assert.deepStrictEqual(
  divide([chunk('12345678'), chunk('12345678')], 15),
  [chunk('12345678'), '\n', chunk('12345678')],
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

assert.strictEqual(
  generateContent([chunk('12345678901234'), chunk('1234567890'), chunk('123456')]),
  '12345678901234\n1234567890123456',
  'SRT生成時は字幕全体の中央に最も近い境界で二行にする',
);

assert.strictEqual(
  generateContent([chunk('12345'), chunk('12345')]),
  '1234512345',
  '短い字幕は二行にしない',
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

console.log('generate_srt_data.js: 13件のテストに成功しました。');
