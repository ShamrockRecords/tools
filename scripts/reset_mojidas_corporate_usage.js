'use strict';
const { mojidasCollection, mojidasRootPath } = require('../modules/mojidas_firestore');
const RUN = 'trial-testing-2026-09-19-v1';
const TARGETS = ['corporateUsageLedger', 'corporateUsageMonths', 'corporateQuotaPeriods', 'corporateQuotaNotifications'];
async function reset(db, confirm = false) {
  const run = mojidasCollection(db, 'corporateUsageResetRuns').doc(RUN);
  return db.runTransaction(async tx => {
    const previous = await tx.get(run);
    if (previous.exists) return { alreadyApplied: true, backup: run.path };
    const reservations = await tx.get(mojidasCollection(db, 'corporateReservations'));
    const active = reservations.docs.filter(doc => ['held', 'consuming'].includes(doc.data().status));
    const expired = active.filter(doc => {
      const lease = doc.data().leaseExpiresAt;
      return lease && new Date(lease.toDate ? lease.toDate() : lease).getTime() < Date.now();
    });
    const snapshots = [];
    for (const name of TARGETS) snapshots.push([name, await tx.get(mojidasCollection(db, name))]);
    const counts = Object.fromEntries(snapshots.map(([name, rows]) => [name, rows.size]));
    const docs = snapshots.flatMap(([name, rows]) => rows.docs.map(doc => ({ name, doc })));
    if (confirm && active.length !== expired.length) throw new Error('期限内の未精算処理があるため中止しました。');
    if ((docs.length + expired.length) * 2 + 1 > 450) throw new Error('一括処理の安全上限を超えています。');
    if (confirm) {
      tx.create(run, { createdAt: new Date(), counts });
      for (const { name, doc } of docs) {
        const key = require('crypto').createHash('sha256').update(doc.ref.path).digest('hex');
        tx.create(run.collection('backup').doc(key), { source: doc.ref.path, data: doc.data() });
        tx.delete(doc.ref);
      }
      for (const doc of expired) {
        const key = require('crypto').createHash('sha256').update(doc.ref.path).digest('hex');
        tx.create(run.collection('backup').doc(key), { source: doc.ref.path, data: doc.data() });
        tx.update(doc.ref, { status: 'cancelled', usageReset: RUN });
      }
    }
    return { applied: confirm, counts, activeReservations: active.length, expiredReservations: expired.length,
      activeDetails: active.map(doc => ({ id: doc.id, status: doc.data().status, operation: doc.data().operation,
        leaseExpiresAt: doc.data().leaseExpiresAt, updatedAt: doc.data().updatedAt })), backup: run.path };
  });
}
async function main() {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  const admin = require('firebase-admin');
  const raw = process.env.FIREBASE_ADMIN_CREDENTIALS || '';
  const credential = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString());
  const projectId = process.env.FIREBASE_PROJECT_ID || credential.project_id;
  if (projectId !== 'tools-aab1b' || mojidasRootPath() !== 'Mojidas/production') throw new Error('対象環境が一致しません。');
  admin.initializeApp({ credential: admin.credential.cert(credential), projectId });
  console.log(JSON.stringify({ projectId, root: mojidasRootPath(), ...await reset(admin.firestore(), process.argv.includes('--confirm')) }));
  const remaining = {};
  for (const name of TARGETS) remaining[name] = (await mojidasCollection(admin.firestore(), name).get()).size;
  console.log(JSON.stringify({ remaining }));
}
module.exports = { reset };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
