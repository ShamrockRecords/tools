const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

module.exports = async function () {
  const listeners = {}, requests = [];
  let replacements = 0, closed = 0, prevented = 0, errors = 0, fail = false;
  const button = { disabled: false };
  const updated = { querySelector(selector) { return selector === 'header' ? { after() {} } : null; } };
  const main = {
    hasAttribute: () => true,
    querySelector: () => null,
    querySelectorAll(selector) { return selector === 'dialog[open]' ? [{ close() { closed++; } }] : [button]; },
    replaceWith(value) { assert.equal(value, updated); replacements++; },
  };
  const context = {
    URL, URLSearchParams,
    FormData: class { constructor(form) { return [['csrfToken', 'fixture'], ['id', form.id], ['status', 'inactive']]; } },
    location: { href: 'https://app.mojidas.jp/admin/mojidas-partners?month=2026-08&year=2025' },
    history: { replaceState() { assert.fail('POSTの保存でページ遷移しない'); } },
    window: { scrollY: 420, scrollTo(x, y) { assert.equal(y, 420); } },
    document: {
      addEventListener(type, listener) { listeners[type] = listener; }, getElementById: () => null,
      createElement: () => ({ dataset: {}, setAttribute() {} }),
    },
    DOMParser: class { parseFromString() { return { querySelector: () => updated }; } },
    async fetch(url, options) {
      requests.push({ url, options });
      if (fail) throw new Error('通信失敗');
      return { ok: true, text: async () => '<main></main>' };
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/javascripts/mojidas-partners.js'), 'utf8'), context);
  for (const action of ['status', 'domains/status', 'edit', 'domains/edit', 'invite', 'domains']) {
    const form = {
      id: action, action: `https://app.mojidas.jp/admin/mojidas-partners/${action}`, method: 'post',
      closest: () => main, hasAttribute: () => false, setAttribute() {}, removeAttribute() {},
      querySelector: () => null, append() { errors++; },
    };
    for (fail of [false, true, false]) {
      const before = replacements;
      await listeners.submit({ target: form, preventDefault() { prevented++; } });
      assert.equal(replacements, before + (fail ? 0 : 1), '失敗時は入力DOMを保持、成功時だけ差し替える');
      assert.equal(button.disabled, false);
      const request = requests.at(-1);
      assert.equal(request.options.headers['X-Requested-With'], 'MojidasDOM');
      assert.equal(request.options.method, 'POST');
      assert.equal(request.url.searchParams.get('month'), '2026-08');
      assert.equal(request.url.searchParams.get('year'), '2025');
      assert.equal(request.options.body.get('csrfToken'), 'fixture');
    }
  }
  assert.equal(prevented, 18);
  assert.equal(replacements, 12);
  assert.equal(closed, 12);
  assert.equal(errors, 6);
  console.log('販売店DOM: 状態適用・編集・詳細・招待・追加の遷移抑止、差し替え、失敗後の再操作を確認');
};
