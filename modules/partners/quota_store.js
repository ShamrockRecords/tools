const { mojidasCollection } = require('../mojidas_firestore');
const { periodAt, quotaStatus, HOUR } = require('./quota_policy');
const { SendGridMailer } = require('../email/sendgrid_mailer');

// 呼び出し元の利用確定transactionへ参加する。キャッシュ作成時だけ台帳を再集計する。
async function readQuota(db, tx, domain, row, now) {
  const period = periodAt(now, row);
  const ref = mojidasCollection(db, 'corporateQuotaPeriods').doc(`${domain}_${period.key}_${row.quotaRevision || 0}`);
  const snapshot = await tx.get(ref);
  let usage = snapshot.exists ? { ...snapshot.data().usage } : { realtime: 0, mediaFile: 0, formalTranslation: 0 };
  if (!snapshot.exists) {
    const ledger = await tx.get(mojidasCollection(db, 'corporateUsageLedger')
      .where('domain', '==', domain).where('occurredAt', '>=', new Date(period.start))
      .where('occurredAt', '<', new Date(period.end)));
    for (const entry of ledger.docs) {
      const data = entry.data();
      if (Object.hasOwn(usage, data.operation)) usage[data.operation] += data.milliseconds;
    }
  }
  return { ref, period, usage, missing: !snapshot.exists };
}
const totalUsage = usage => Object.values(usage).reduce((sum, value) => sum + value, 0);
function saveQuota(tx, quota) {
  tx.set(quota.ref, { usage: quota.usage, start: new Date(quota.period.start), end: new Date(quota.period.end) });
}

// 送信前に宛先別のリースを取得し、同時報告による重複メールを抑止する。
// 配送失敗は次の利用報告・残高取得で再試行する。利用確定は巻き戻さない。
async function notifyQuota(db, domain, row, quota, now, mailer) {
  const status = quotaStatus(row, totalUsage(quota.usage));
  if (!row.notifyAtOneHour || status.remainingMilliseconds === null || status.remainingMilliseconds > HOUR) return;
  const partner = row.partnerID === 'self' ? null : await mojidasCollection(db, 'partners').doc(row.partnerID).get();
  const recipients = [...new Set([row.contactEmail, row.partnerID === 'self' ? 'app@mojidas.jp' : partner.exists && partner.data().email]
    .filter(Boolean).map(value => value.trim().toLowerCase()))];
  const sender = mailer || new SendGridMailer({ fromEmail: process.env.MOJIDAS_AUTH_FROM_EMAIL || process.env.SENDGRID_FROM_EMAIL, fromName: 'Mojidas' });
  for (const recipient of recipients) {
    const digest = require('crypto').createHash('sha256').update(recipient).digest('hex');
    const ref = mojidasCollection(db, 'corporateQuotaNotifications').doc(`${domain}_${quota.period.start}_${digest}`);
    const claimed = await db.runTransaction(async tx => {
      const previous = await tx.get(ref), data = previous.exists ? previous.data() : {};
      if (data.sent || data.leaseUntil > now) return false;
      tx.set(ref, { ...data, leaseUntil: now + 60000 }); return true;
    });
    if (!claimed) continue;
    try {
      await sender.send({ to: recipient, subject: 'Mojidas 法人利用の残り時間が1時間以下になりました',
        text: `${row.organizationName || domain}（${domain}）の法人利用時間が残り1時間以下になりました。\n上限：${row.limitMilliseconds / HOUR}時間\n利用時間：${(status.usedMilliseconds / HOUR).toFixed(2)}時間\n次回リセット：${new Date(quota.period.end).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}\n${row.stopAtLimit ? '上限に達すると利用を停止します。' : '上限を超えても利用を継続します。'}`,
        categories: ['mojidas-corporate-quota'] });
      await ref.set({ sent: true, sentAt: new Date(now), leaseUntil: 0 });
    } catch (error) {
      await ref.set({ sent: false, leaseUntil: 0 });
      console.warn('[Mojidas] 法人上限通知の送信失敗', error.code || 'MAIL_FAILED');
    }
  }
}
module.exports = { readQuota, saveQuota, totalUsage, notifyQuota };
