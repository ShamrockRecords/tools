const assert = require('assert');
const { TransactionalFirestore } = require('./mojidas_credit_integrity.test');
const { MojidasActivityNotifications } = require('../modules/email/mojidas_activity_notifications');

module.exports = async function () {
  const db = new TransactionalFirestore(), sent = [];
  const options = { firestoreProvider: () => db, now: () => Date.parse('2026-09-19T00:00:00Z'),
    mailer: { async send(message) { sent.push(message); } } };
  const notifier = new MojidasActivityNotifications(options);
  const account = { userID: 'user-1', email: 'user@example.com', password: 'DO_NOT_SEND', token: 'DO_NOT_SEND' };
  await Promise.all(Array.from({ length: 5 }, () => notifier.registration(account)));
  await new MojidasActivityNotifications(options).registration(account);
  assert.equal(sent.length, 1, '並行・再起動相当の再送でも一度だけ');
  const charge = { sessionID: 'cs_1', userID: 'user-1', email: account.email, milliseconds: 3600000, totalJPY: 330 };
  await Promise.all([notifier.charge(charge), notifier.charge(charge)]);
  await notifier.charge({ ...charge, sessionID: 'cs_2' });
  assert.equal(sent.length, 3, '別決済はそれぞれ通知');
  for (const message of sent) {
    assert.equal(message.to, 'app@mojidas.jp');
    assert(!JSON.stringify(message).includes('DO_NOT_SEND'));
    assert(message.text.includes(account.email));
  }
  assert(sent[1].text.includes('60分'));
  assert(sent[1].text.includes('330円'));
  let attempts = 0;
  const failing = new MojidasActivityNotifications({ ...options, mailer: { async send() { attempts++; throw new Error('timeout'); } } });
  await failing.charge({ ...charge, sessionID: 'failed' });
  const snapshot = structuredClone(db.collections);
  await failing.charge({ ...charge, sessionID: 'failed' });
  assert.equal(attempts, 1, '結果不明の送信を自動で繰り返さない');
  assert.deepStrictEqual(db.collections, snapshot);
  assert(db.records('Mojidas/production/activityNotifications').some(record => record.data.status === 'failed'));
  const unavailable = new MojidasActivityNotifications({ ...options, firestoreProvider() { throw new Error('offline'); } });
  await unavailable.registration(account);
  assert.equal(sent.length, 3, '重複防止記録を確保できなければ送信しない');
  assert.deepStrictEqual([...db.collections.keys()], ['Mojidas/production/activityNotifications'], 'ユーザー・残高・台帳を書き換えない');
  console.log('登録・チャージ通知: 宛先、内容、並行再送、障害、再起動、データ保全を確認');
};
