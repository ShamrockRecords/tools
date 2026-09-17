#!/usr/bin/env node
'use strict';
const { idFor } = require('./reset_mojidas_release_credits');
const { mojidasCollectionPath, mojidasRootPath } = require('../modules/mojidas_firestore');
const { summarizePaidBalance } = require('../modules/billing/mojidas_paid_balance_store');
const RUN = 'release-1-0-0-report-reset-v1';
const GIFT = 3600000;

function planReportReset(users, grants) {
  const canonical = new Set(users.map(user => idFor('credit', `${user.uid}:signup-gift-v1`)));
  const changes = [];
  for (const grant of grants) {
    const before = grant.data;
    if (before.type === 'purchased') {
      // 決済IDは残し、Stripe webhookの再送による二重付与を防止する。
      changes.push({ id: grant.id, before, after: { ...before, remainingMilliseconds: 0, releaseReset: RUN } });
    } else if (before.type === 'promotional' && canonical.has(grant.id)) {
      if (before.remainingMilliseconds !== GIFT) throw new Error('前回設定した無償残高に変化があるため中止しました。');
      changes.push({ id: grant.id, before, after: { ...before, totalMilliseconds: GIFT,
        metadata: { ...before.metadata, reason: '1.0.0リリース無償提供' }, releaseReset: RUN } });
      canonical.delete(grant.id);
    } else if (before.type === 'promotional') {
      if (before.remainingMilliseconds !== 0) throw new Error('旧無償付与に残高があるため中止しました。');
      // 旧実績はバックアップへ退避し、現在の集計から除外する。
      changes.push({ id: grant.id, before, after: null });
    }
  }
  if (canonical.size) throw new Error('ユーザーの無償付与が見つかりません。');
  if (changes.length * 2 + 1 > 450) throw new Error('一括処理の安全上限を超えています。');
  return changes;
}

async function main() {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  const admin = require('firebase-admin');
  const raw = process.env.FIREBASE_ADMIN_CREDENTIALS || '';
  const credential = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString());
  const projectId = process.env.FIREBASE_PROJECT_ID || credential.project_id;
  admin.initializeApp({ credential: admin.credential.cert(credential), projectId });
  const db = admin.firestore(), users = []; let token;
  do { const page = await admin.auth().listUsers(1000, token); users.push(...page.users.map(user => ({ uid: user.uid }))); token = page.pageToken; } while (token);
  if (projectId !== 'tools-aab1b' || mojidasRootPath() !== 'Mojidas/production' || users.length !== 24)
    throw new Error('確認済みの環境・ユーザー数と異なります。');
  const collection = name => db.collection(mojidasCollectionPath(name));
  const ref = collection('creditResetRuns').doc(RUN), confirm = process.argv.includes('--confirm');
  const result = await db.runTransaction(async tx => {
    const previous = await tx.get(ref);
    if (previous.exists) return { alreadyApplied: true };
    const reservations = await tx.get(collection('creditReservations'));
    if (reservations.docs.some(doc => ['held', 'consuming'].includes(doc.data().status)))
      throw new Error('未精算の予約があるため中止しました。');
    const snapshot = await tx.get(collection('creditGrants'));
    const grants = snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() }));
    const changes = planReportReset(users, grants), now = new Date();
    const backup = { users, grants, occurredAt: now, projectId, changes: changes.map(item => item.id) };
    if (Buffer.byteLength(JSON.stringify(backup)) > 800000) throw new Error('バックアップサイズ超過');
    if (confirm) {
      tx.set(ref, backup);
      for (const change of changes) {
        const grantRef = collection('creditGrants').doc(change.id);
        if (change.after) tx.set(grantRef, change.after); else tx.delete(grantRef);
        tx.set(collection('usageLedger').doc(idFor('releaseReset', `${RUN}:${change.id}`)), {
          userID: change.before.userID, grantID: change.id, reservationID: null, kind: 'adjustment',
          milliseconds: (change.after?.remainingMilliseconds || 0) - change.before.remainingMilliseconds,
          occurredAt: now, idempotencyKey: `${RUN}:${change.id}`,
          metadata: { reason: RUN, archived: !change.after, previousTotalMilliseconds: change.before.totalMilliseconds,
            previousRemainingMilliseconds: change.before.remainingMilliseconds },
        });
      }
    }
    return { applied: confirm, users: users.length, purchasedRecords: changes.filter(item => item.before.type === 'purchased').length,
      promotionalRecords: changes.filter(item => item.after?.type === 'promotional').length,
      archivedPromotionalRecords: changes.filter(item => !item.after).length };
  });
  console.log(JSON.stringify({ projectId, root: mojidasRootPath(), ...result }));
  if (!confirm && !result.alreadyApplied) return;
  const snapshot = await collection('creditGrants').get(), backup = (await ref.get()).data();
  const byID = new Map(snapshot.docs.map(doc => [doc.id, doc.data()]));
  for (const grant of backup.grants.filter(item => !['purchased', 'promotional'].includes(item.data.type)))
    if (JSON.stringify(grant.data) !== JSON.stringify(byID.get(grant.id))) throw new Error('無料・テスト時間等に変更があります。');
  const report = summarizePaidBalance({ grantDocuments: snapshot.docs, promotionalDocuments: snapshot.docs,
    ledgerDocuments: [], now: new Date() });
  if (report.totalRemainingMilliseconds !== 0 || report.unusedPaidBalanceJPY !== 0
      || report.promotional.grantedMilliseconds !== users.length * GIFT
      || report.promotional.remainingMilliseconds !== users.length * GIFT || report.promotional.consumedMilliseconds !== 0
      || report.promotional.expiredMilliseconds !== 0 || report.promotional.grantCount !== users.length)
    throw new Error('集計の検証値が一致しません。');
  console.log(JSON.stringify({ paidRemainingMilliseconds: report.totalRemainingMilliseconds, paidJPY: report.unusedPaidBalanceJPY,
    promotionalHours: report.promotional.grantedMilliseconds / GIFT, promotionalConsumed: 0,
    monthlyFreeAndTestCreditsPreserved: true, backup: ref.path }));
}
module.exports = { planReportReset };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
