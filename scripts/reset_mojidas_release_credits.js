#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { monthlyPeriod } = require('../modules/credit/mojidas_credit_store');
const { mojidasCollectionPath, mojidasRootPath } = require('../modules/mojidas_firestore');
const RUN = 'release-1-0-0-credit-reset-v1';
const FREE = 1800000, GIFT = 3600000;
const idFor = (prefix, value) => `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
const dateOf = value => value?.toDate ? value.toDate() : value ? new Date(value) : null;

// 純粋な変更計画。購入分・テスト用時間・期限切れの履歴は変更しない。
function planReset(users, grants, now) {
  const changes = [];
  const add = (id, before, after) => changes.push({ id, before: before || null, after });
  for (const user of users) {
    const owned = grants.filter(item => item.data.userID === user.uid);
    const period = monthlyPeriod(user.createdAt, now);
    const monthlyID = idFor('monthly', `${user.uid}:${period.startsAt.toISOString()}`);
    // 通常の新規登録特典と同じIDを使い、次のログインで1時間が二重付与されるのを防ぐ。
    const giftID = idFor('credit', `${user.uid}:signup-gift-v1`);
    for (const grant of owned) {
      if (!['monthlyFree', 'promotional'].includes(grant.data.type)) continue;
      if (grant.id === monthlyID || grant.id === giftID) continue;
      const expiry = dateOf(grant.data.expiresAt);
      if (expiry && expiry <= now) continue;
      if (grant.data.remainingMilliseconds > 0)
        add(grant.id, grant.data, { ...grant.data, remainingMilliseconds: 0, releaseReset: RUN });
    }
    for (const [id, type, amount] of [[monthlyID, 'monthlyFree', FREE], [giftID, 'promotional', GIFT]]) {
      const before = owned.find(item => item.id === id)?.data;
      if (before && before.type !== type) throw new Error('付与IDの種別が一致しません。');
      const after = { ...before, userID: user.uid, type,
        totalMilliseconds: Math.max(before?.totalMilliseconds || 0, amount), remainingMilliseconds: amount,
        startsAt: type === 'monthlyFree' ? period.startsAt : now,
        expiresAt: type === 'monthlyFree' ? period.expiresAt : null,
        createdAt: before?.createdAt || now, releaseReset: RUN,
        sourceReference: before?.sourceReference || (type === 'monthlyFree' ? `monthlyFree:${period.startsAt.toISOString()}` : 'signup-gift-v1'),
      };
      if (type === 'promotional') after.label = '1.0.0リリース無償提供（1時間）';
      add(id, before, after);
    }
  }
  if (changes.length * 2 + 1 > 450) throw new Error('一括更新の安全上限を超えています。');
  return changes;
}

async function main() {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  const admin = require('firebase-admin');
  const raw = process.env.FIREBASE_ADMIN_CREDENTIALS || '';
  const credential = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString());
  const projectId = process.env.FIREBASE_PROJECT_ID || credential.project_id;
  admin.initializeApp({ credential: admin.credential.cert(credential), projectId });
  const db = admin.firestore(), users = []; let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    users.push(...page.users.map(user => ({ uid: user.uid, createdAt: user.metadata.creationTime })));
    pageToken = page.pageToken;
  } while (pageToken);
  const confirm = process.argv.includes('--confirm');
  if (confirm && (projectId !== 'tools-aab1b' || mojidasRootPath() !== 'Mojidas/production' || users.length !== 24))
    throw new Error('確認済みの対象環境・ユーザー数と異なるため中止しました。');
  const collection = name => db.collection(mojidasCollectionPath(name));
  const runRef = collection('creditResetRuns').doc(RUN);
  const result = await db.runTransaction(async tx => {
    const previousRun = await tx.get(runRef);
    if (previousRun.exists) return { alreadyApplied: true, users: previousRun.data().users.length };
    const reservations = await tx.get(collection('creditReservations'));
    if (reservations.docs.some(doc => ['held', 'consuming'].includes(doc.data().status)))
      throw new Error('未精算の予約があるため中止しました。');
    const snapshot = await tx.get(collection('creditGrants'));
    const grants = snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() }));
    const now = new Date(), changes = planReset(users, grants, now);
    // 変更前の全付与を同じtransactionで保存し、後から照合・復旧判断できるようにする。
    const backup = { users, grants, occurredAt: now, changes: changes.map(item => item.id), projectId };
    if (Buffer.byteLength(JSON.stringify(backup)) > 800000) throw new Error('バックアップが安全サイズを超えています。');
    if (confirm) {
      tx.set(runRef, backup);
      for (const change of changes) {
        tx.set(collection('creditGrants').doc(change.id), change.after);
        tx.set(collection('usageLedger').doc(idFor('releaseReset', `${RUN}:${change.id}`)), {
          userID: change.after.userID, grantID: change.id, reservationID: null,
          kind: 'adjustment', milliseconds: change.after.remainingMilliseconds - (change.before?.remainingMilliseconds || 0),
          occurredAt: now, idempotencyKey: `${RUN}:${change.id}`,
          metadata: { reason: RUN, previousRemainingMilliseconds: change.before?.remainingMilliseconds || 0,
            remainingMilliseconds: change.after.remainingMilliseconds },
        });
      }
    }
    return { users: users.length, changedGrants: changes.length, applied: confirm };
  });
  console.log(JSON.stringify({ projectId, root: mojidasRootPath(), ...result }));
  if (!confirm && !result.alreadyApplied) return;
  const backup = (await runRef.get()).data();
  const after = await collection('creditGrants').get();
  const byID = new Map(after.docs.map(doc => [doc.id, doc.data()]));
  const now = new Date(); let verified = 0;
  for (const user of backup.users) {
    const active = after.docs.map(doc => doc.data()).filter(data => data.userID === user.uid
      && (!dateOf(data.startsAt) || dateOf(data.startsAt) <= now) && (!dateOf(data.expiresAt) || dateOf(data.expiresAt) > now));
    const sum = type => active.filter(data => data.type === type).reduce((total, data) => total + data.remainingMilliseconds, 0);
    if (sum('monthlyFree') !== FREE || sum('promotional') !== GIFT) throw new Error('実行後の無料・無償残高が一致しません。');
    verified++;
  }
  for (const grant of backup.grants.filter(item => !['monthlyFree', 'promotional'].includes(item.data.type))) {
    if (JSON.stringify(grant.data) !== JSON.stringify(byID.get(grant.id))) throw new Error('対象外の付与に変更があります。');
  }
  console.log(JSON.stringify({ verifiedUsers: verified, monthlyFreeMinutes: 30, promotionalMinutes: 60,
    otherGrantsPreserved: true, backup: runRef.path }));
}
module.exports = { planReset, idFor };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
