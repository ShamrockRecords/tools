const { createHash } = require('crypto');
const { getFirestore } = require('../firestore');
const { mojidasCollection } = require('../mojidas_firestore');
const { SendGridMailer } = require('./sendgrid_mailer');

class MojidasActivityNotifications {
  constructor({ firestoreProvider = getFirestore, mailer, now = Date.now } = {}) {
    this.firestoreProvider = firestoreProvider;
    this.now = now;
    this.mailer = mailer || new SendGridMailer({
      fromEmail: process.env.MOJIDAS_AUTH_FROM_EMAIL || 'no-reply@mojidas.jp',
      fromName: 'Mojidas',
    });
  }

  async registration({ userID, email }) {
    return this.sendOnce(`registration:${userID}`, 'Mojidas 新規アカウント登録', [
      `ユーザーID: ${userID}`, `メールアドレス: ${email}`,
      'アカウント作成時点の通知です。メールアドレスの認証完了を示すものではありません。',
    ]);
  }

  async charge({ sessionID, userID, email, milliseconds, totalJPY }) {
    return this.sendOnce(`charge:${sessionID}`, 'Mojidas 時間チャージ完了', [
      `ユーザーID: ${userID}`, `メールアドレス: ${email || '未取得'}`,
      `チャージ時間: ${milliseconds / 60000}分`, `購入金額: ${totalJPY}円`,
      `決済ID: ${sessionID}`, '決済を確認し、音声認識時間を付与しました。',
    ]);
  }

  async sendOnce(key, subject, lines) {
    // 送信前に永続記録を確保し、Webhook再送・並行処理・再起動でも重複送信しない。
    // メールとDBは原子的に確定できないため、不明な送信結果を自動再送しない。
    let ref;
    try {
      const db = this.firestoreProvider();
      ref = mojidasCollection(db, 'activityNotifications').doc(createHash('sha256').update(key).digest('hex'));
      const claimed = await db.runTransaction(async tx => {
        if ((await tx.get(ref)).exists) return false;
        tx.set(ref, { status: 'attempted', attemptedAt: this.now() });
        return true;
      });
      if (!claimed) return;
      try {
        await this.mailer.send({ to: 'app@mojidas.jp', subject,
          text: [...lines, `通知日時: ${new Date(this.now()).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}（日本時間）`].join('\n'),
          categories: ['mojidas-activity'] });
      } catch (_) {
        await ref.update({ status: 'failed' });
        console.warn('[Mojidas] activity notification delivery failed');
        return;
      }
      await ref.update({ status: 'sent', sentAt: this.now() });
    } catch (_) {
      // 登録・購入の確定結果は通知障害で取り消さない。個人情報や秘密はログに残さない。
      console.warn('[Mojidas] activity notification unavailable');
    }
  }
}

module.exports = { MojidasActivityNotifications, mojidasActivityNotifications: new MojidasActivityNotifications() };
