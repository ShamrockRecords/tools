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
    page: 2, pagination: { totalUsers: 201, totalPages: 11, startIndex: 21, endIndex: 40 }, csrfToken: 'fixture-csrf',
    createOperationID: () => `operation-${operation++}`, formatDate: value => value,
    formatCreditTime: value => `${value / 60000}分` };
  const view = path.join(__dirname, '../views/admin/mojidas-users.ejs');
  const html = await ejs.renderFile(view, locals);
  const { userStatistics } = require('../modules/auth/mojidas_user_statistics');
  const now = Date.parse('2026-09-18T15:00:00Z');
  const fixtures = [
    { uid: 'a', metadata: { creationTime: '2026-09-18T14:59:59Z' } },
    { uid: 'b', metadata: { creationTime: '2026-09-18T15:00:00Z' } },
    { uid: 'c', metadata: { creationTime: '2026-09-12T15:00:00Z' } },
    { uid: 'd', metadata: { creationTime: '2026-09-12T14:59:59Z' } },
  ];
  const statistics = userStatistics(fixtures, new Map([
    ['a', { macos: { version: '1.2.3' } }],
    ['b', { windows: { version: '1.2.3.4' } }],
    ['c', { macos: { version: '1.2.3' }, windows: { version: '1.2.3.4' } }],
    ['deleted', { macos: { version: '1.2.3' } }],
  ]), now);
  assert.deepStrictEqual(statistics.days.map(day => day.count), [1, 0, 0, 0, 0, 1, 1]);
  assert.strictEqual(statistics.days[6].date, '2026-09-19');
  assert.deepStrictEqual(statistics.platforms.map(item => item.count), [1, 1, 1, 1]);
  assert.deepStrictEqual(statistics.versions.macos.items.map(({ version, count }) => [version, count]), [['1.2.3', 2]]);
  assert.strictEqual(statistics.versions.windows.total, 2);
  assert.strictEqual(statistics.versions.macos.unknown, 2);
  const versionClients = new Map([
    ['a', { macos: { version: '1.9.0' }, windows: { version: '1.2.0.0' } }],
    ['b', { macos: { version: '1.10.0' }, windows: { version: '<script>' } }],
    ['c', { macos: { version: '1.10.0' }, windows: { version: '1.3.0.0' } }],
    ['d', { macos: { version: '1.2.3.4' } }],
    ['deleted', { macos: { version: '9.0.0' } }],
  ]);
  const before = JSON.stringify([...versionClients]);
  const versions = userStatistics(fixtures, versionClients, now).versions;
  assert.deepStrictEqual(versions.macos.items.map(({ version, count }) => [version, count]), [['1.10.0', 2], ['1.9.0', 1]]);
  assert.strictEqual(versions.macos.total, 3);
  assert.strictEqual(versions.macos.unknown, 1);
  assert.strictEqual(versions.windows.total, 2);
  assert.strictEqual(JSON.stringify([...versionClients]), before);
  const charts = await ejs.renderFile(view, { ...locals, statistics });
  assert(charts.includes('conic-gradient('));
  assert(charts.includes('25.0%'));
  assert(charts.includes('過去7日間の新規ユーザー'));
  assert(charts.includes('Macのバージョン割合'));
  assert(charts.includes('Windowsのバージョン割合'));
  assert(charts.includes('1.2.3：2人（100.0%）'));
  assert.strictEqual((charts.match(/conic-gradient\(/g) || []).length, 3);
  const failedCharts = await ejs.renderFile(view, { ...locals, statistics: userStatistics(fixtures, null, now) });
  assert(failedCharts.includes('OS情報を取得できませんでした'));
  assert.strictEqual(userStatistics(fixtures, null, now).versions, null);
  const emptyCharts = await ejs.renderFile(view, { ...locals, statistics: userStatistics([], new Map(), now) });
  assert(!emptyCharts.includes('NaN'));
  assert(!emptyCharts.includes('conic-gradient('));
  assert.strictEqual((html.match(/aria-label="ユーザー一覧ページ"/g) || []).length, 2);
  assert(html.includes('全201件中 21〜40件（2 / 11ページ）'));
  assert(html.includes('href="/admin/mojidas-users?page=11"'));
  assert(html.includes('aria-current="page">2</span>'));
  const firstPage = await ejs.renderFile(view, { ...locals, page: 1 });
  assert(!firstPage.includes('page=0'));
  assert(firstPage.includes('aria-disabled="true">前へ'));
  const lastPage = await ejs.renderFile(view, { ...locals, page: 11 });
  assert(lastPage.includes('aria-disabled="true">次へ'));
  assert(!lastPage.includes('page=12'));
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
