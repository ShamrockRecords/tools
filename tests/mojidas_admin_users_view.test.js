const assert = require('assert');
const path = require('path');
const ejs = require('ejs');

async function render() {
  const users = [false, true].map((invitedUnlimited, index) => ({
    uid: `fixture-${index}`, email: `user${index}@example.invalid`,
    createdAt: '2026-09-15', lastSignInAt: '非表示のログイン日時',
    disabled: index === 1, emailVerified: true, invitedUnlimited, isCorporate: index === 0,
    appClients: { macos: { version: '0.29.0', lastSeenAt: '非表示の確認日時' } },
    credit: { monthlyFreeMilliseconds: 1800000, purchasedMilliseconds: 0,
      promotionalMilliseconds: 0, totalMilliseconds: 1800000, otherMilliseconds: 0 },
  }));
  let operation = 0;
  const locals = { user: { email: 'admin@example.invalid' }, users, flash: null,
    page: 2, hasNext: true, csrfToken: 'fixture-csrf',
    createOperationID: () => `operation-${operation++}`, formatDate: value => value,
    formatCreditTime: value => `${value / 60000}分` };
  const view = path.join(__dirname, '../views/admin/mojidas-users.ejs');
  const html = await ejs.renderFile(view, locals);
  assert(html.includes('>バージョン</th>'));
  assert(html.includes('>操作</th>'));
  for (const removed of ['メール確認済み', '最終ログイン', '最終アプリバージョン', '非表示の確認日時']) {
    assert(!html.includes(removed), removed);
  }
  for (let index = 0; index < 2; index++) {
    const modal = html.split(`id="user-settings-${index}"`)[1].split('</td>')[0];
    assert(modal.includes(`/fixture-${index}/promotional-hours`));
    assert(modal.includes(`/fixture-${index}/invited-unlimited`));
    assert(!modal.includes(`/fixture-${1 - index}/`));
    assert(modal.includes(`value="operation-${index}"`));
    assert.strictEqual((modal.match(/name="csrfToken" value="fixture-csrf"/g) || []).length, 2);
    assert.strictEqual((modal.match(/name="page" value="2"/g) || []).length, 2);
    assert(modal.includes(`name="enabled" value="${index === 0 ? 'true' : 'false'}"`));
    assert(modal.includes('data-bs-dismiss="modal"'));
  }
  assert(html.includes('招待ユーザーにする'));
  assert(html.includes('招待ユーザーを解除'));
  const empty = await ejs.renderFile(view, { ...locals, users: [] });
  assert(empty.includes('colspan="9"'));
  assert(html.includes('>種別</th>'));
  assert(html.includes('>招待</span>'));
  assert(html.includes('>法人</span>'));
  const regular = await ejs.renderFile(view, { ...locals, users: [{ ...users[0], isCorporate: false }] });
  assert(!regular.includes('>法人</span>'));
  assert(!regular.includes('>招待</span>'));
  for (const label of ['毎月の無料', '有償購入', '無償提供', '合計']) {
    assert(html.includes(`>${label}</th>`));
  }
  const failed = await ejs.renderFile(view, { ...locals, users: [{ ...users[0], credit: null }] });
  assert.strictEqual((failed.match(/>取得失敗</g) || []).length, 4);
  // 招待の合計セルは、残高取得失敗時やその他残高がある場合も空白にする。
  for (const credit of [{ ...users[1].credit, otherMilliseconds: 60000 }, null]) {
    const invited = await ejs.renderFile(view, { ...locals, users: [{ ...users[1], credit }] });
    const cells = [...invited.matchAll(/<td class="text-nowrap text-end">([\s\S]*?)<\/td>/g)];
    assert.strictEqual(cells.length, 4);
    assert.strictEqual(cells[3][1].trim(), '');
    assert(cells.slice(0, 3).every(cell => cell[1].trim().length > 0));
  }
  return html;
}

if (require.main === module) {
  render().then(html => {
    console.log('Mojidasユーザー管理: 表示項目・操作対象・CSRF・ページ・操作IDを検証');
    if (process.argv.includes('--preview')) {
      require('http').createServer((req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
      }).listen(4319, '127.0.0.1');
    }
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
