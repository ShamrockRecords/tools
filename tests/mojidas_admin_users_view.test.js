const assert = require('assert');
const path = require('path');
const ejs = require('ejs');

async function render() {
  const users = [false, true].map((invitedUnlimited, index) => ({
    uid: `fixture-${index}`, email: `user${index}@example.invalid`,
    createdAt: '2026-09-15', lastSignInAt: '非表示のログイン日時',
    disabled: index === 1, emailVerified: true, invitedUnlimited,
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
  assert(empty.includes('colspan="5"'));
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
