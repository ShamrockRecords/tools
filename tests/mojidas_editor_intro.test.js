const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

async function main() {
  for (const locale of ['ja', 'en']) {
    const messages = require(`../locales/${locale}.json`);
    for (const mediaType of ['file', 'youtube']) {
      const html = await ejs.renderFile(path.join(__dirname, '../views/tools/captionEditor/index.ejs'), {
        appTitle: '字幕エディター', rootURL: 'http://localhost', mediaType,
        __: key => messages[key] || key,
      });
      assert.strictEqual((html.match(/<aside class="mojidas-editor-intro"/g) || []).length, 1);
      assert(html.includes(messages.mojidasIntroDescription));
      assert(html.includes(messages.mojidasIntroLink));
      assert(html.includes('href="https://mojidas.jp/" target="_blank" rel="noopener noreferrer"'));
      assert(html.includes('src="/assets/mojidas-logo.png" alt="Mojidas"'));
      assert(html.includes('/stylesheets/mojidas-editor-intro.css'));
    }
  }
  assert(fs.existsSync(path.join(__dirname, '../public/assets/mojidas-logo.png')));
  const css = fs.readFileSync(path.join(__dirname, '../public/stylesheets/mojidas-editor-intro.css'), 'utf8');
  const logoStyle = css.match(/\.mojidas-editor-intro-logo\s*\{([^}]+)\}/)[1];
  assert.match(logoStyle, /border-radius:\s*999px/);
  assert.match(logoStyle, /background:\s*#ffffff/);
  assert.match(logoStyle, /padding:\s*6px 16px/);
  console.log('字幕エディター両版・日本語／英語のMojidas紹介表示テスト成功');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
