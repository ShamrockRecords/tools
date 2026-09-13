const crypto = require('crypto');
const firebaseAdmin = require('firebase-admin');
const { getFirestore } = require('../firestore');
const { mojidasCollection } = require('../mojidas_firestore');
const { sendGridRequest } = require('./sendgrid_mailer');
const { mojidasAccountDeletionService, normalizeEmail } = require('../auth/mojidas_account_deletion');

const BATCH_SIZE = 500;
const DRAFT_LIFETIME = 30 * 60 * 1000;
const STALE_AFTER = 5 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function fail(code, message) { return Object.assign(new Error(message), { code }); }
function millis(value) { return value?.toDate ? value.toDate().getTime() : new Date(value).getTime(); }

class MojidasBroadcastService {
  constructor({ firestoreProvider = getFirestore, authProvider = () => firebaseAdmin.auth(),
    requester = sendGridRequest, now = () => Date.now(), deletionService = mojidasAccountDeletionService,
    configuration = () => ({ apiKey: process.env.SENDGRID_API_KEY, fromEmail: process.env.MOJIDAS_BROADCAST_FROM_EMAIL }) } = {}) {
    Object.assign(this, { firestoreProvider, authProvider, requester, now, configuration, deletionService });
    this.tasks = new Map();
  }
  collection(name) { return mojidasCollection(this.firestoreProvider(), name); }
  document(id) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id || '')) {
      throw fail('BROADCAST_NOT_FOUND', '配信履歴が見つかりません。');
    }
    return this.collection('mailBroadcasts').doc(id);
  }
  async prepare({ subject, body, adminEmail }) {
    if (typeof subject !== 'string' || !subject.trim() || subject.trim().length > 200 || /[\r\n]/.test(subject)
      || typeof body !== 'string' || !body.trim() || body.length > 50000) {
      throw fail('INVALID_BROADCAST', '件名は200文字以内、本文は50,000文字以内で入力してください。件名に改行は使えません。');
    }
    const id = crypto.randomUUID();
    const document = this.document(id);
    await document.set({ subject: subject.trim(), body, adminEmail, createdAt: new Date(this.now()),
      updatedAt: new Date(this.now()), status: 'preparing', recipientCount: 0, acceptedCount: 0,
      batchCount: 0, skippedCount: 0, duplicateCount: 0, excludedCount: 0, uncertainCount: 0 });
    try {
      const recipients = [], seen = new Set(), tokens = new Set();
      let pageToken, skippedCount = 0, duplicateCount = 0;
      do {
        const page = await this.authProvider().listUsers(1000, pageToken);
        const deleted = new Set();
        for (let offset = 0; offset < page.users.length; offset += 100) {
          await Promise.all(page.users.slice(offset, offset + 100).map(async user => {
            if (typeof user.email === 'string' && EMAIL.test(user.email.trim())
              && await this.deletionService.isEmailDeleted(user.email)) deleted.add(user.uid);
          }));
        }
        for (const user of page.users) {
          const email = typeof user.email === 'string' ? user.email.trim() : '';
          if (!EMAIL.test(email) || email.length > 254 || deleted.has(user.uid)) { skippedCount += 1; continue; }
          const key = normalizeEmail(email);
          if (seen.has(key)) { duplicateCount += 1; continue; }
          seen.add(key);
          recipients.push({ uid: user.uid, email });
        }
        pageToken = page.pageToken;
        if (pageToken && tokens.has(pageToken)) throw fail('BROADCAST_PREPARATION_FAILED', 'ユーザー一覧を最後まで取得できませんでした。');
        if (pageToken) tokens.add(pageToken);
      } while (pageToken);
      if (!recipients.length) throw fail('INVALID_BROADCAST', '送信可能なメールアドレスがありません。');
      for (let offset = 0; offset < recipients.length; offset += BATCH_SIZE) {
        await this.collection('mailBroadcastBatches').doc(`${id}-${offset / BATCH_SIZE}`).set({
          broadcastID: id, recipients: recipients.slice(offset, offset + BATCH_SIZE), status: 'pending',
        });
      }
      await document.update({ status: 'draft', recipientCount: recipients.length, skippedCount, duplicateCount,
        batchCount: Math.ceil(recipients.length / BATCH_SIZE), updatedAt: new Date(this.now()) });
      return this.get(id);
    } catch (error) {
      await document.update({ status: 'preparation_failed', updatedAt: new Date(this.now()) });
      throw error;
    }
  }
  async get(id) {
    const snapshot = await this.document(id).get();
    if (!snapshot.exists) throw fail('BROADCAST_NOT_FOUND', '配信履歴が見つかりません。');
    return this.publicJob(snapshot.id, snapshot.data());
  }
  publicJob(id, data) {
    let status = data.status;
    if (status === 'draft' && this.now() - millis(data.updatedAt) > DRAFT_LIFETIME) status = 'expired';
    if (['preparing', 'sending'].includes(status) && this.now() - millis(data.updatedAt) > STALE_AFTER) status = 'attention';
    return { id, ...data, status };
  }
  async listRecent() {
    const snapshot = await this.collection('mailBroadcasts').orderBy('createdAt', 'desc').limit(20).get();
    return snapshot.docs.map(doc => this.publicJob(doc.id, doc.data()));
  }
  async start(id, adminEmail) {
    const { apiKey, fromEmail } = this.configuration();
    if (!apiKey || !EMAIL.test(fromEmail || '')) {
      throw fail('SENDGRID_NOT_CONFIGURED', 'SENDGRID_API_KEYとMOJIDAS_BROADCAST_FROM_EMAILを設定してください。');
    }
    const document = this.document(id);
    const claimed = await this.firestoreProvider().runTransaction(async transaction => {
      const snapshot = await transaction.get(document);
      if (!snapshot.exists) throw fail('BROADCAST_NOT_FOUND', '配信履歴が見つかりません。');
      const job = snapshot.data();
      if (job.status !== 'draft') return false;
      if (this.now() - millis(job.updatedAt) > DRAFT_LIFETIME) throw fail('BROADCAST_EXPIRED', '確認画面の有効期限が切れました。宛先を再取得してください。');
      transaction.update(document, { status: 'sending', sentBy: adminEmail, updatedAt: new Date(this.now()) });
      return true;
    });
    if (claimed) {
      const task = this.deliver(id, { apiKey, fromEmail }).catch(async () => {
        // DB障害等で最終状態を保存できない場合も自動再送しない。古いsendingは画面で要確認となる。
        await document.update({ status: 'attention', updatedAt: new Date(this.now()) }).catch(() => {});
      }).finally(() => this.tasks.delete(id));
      this.tasks.set(id, task);
    }
    return this.get(id);
  }
  async currentRecipients(snapshotRecipients) {
    const recipients = [];
    // Firebase Authの一括照会は100件ずつ。削除済み・削除途中・アドレス変更後は送らない。
    for (let offset = 0; offset < snapshotRecipients.length; offset += 100) {
      const group = snapshotRecipients.slice(offset, offset + 100);
      const result = await this.authProvider().getUsers(group.map(item => ({ uid: item.uid })));
      const existing = new Map(result.users.map(user => [user.uid, user]));
      const eligible = await Promise.all(group.map(async item => {
        const current = existing.get(item.uid);
        if (!current?.email || normalizeEmail(current.email) !== normalizeEmail(item.email)) return null;
        if (await this.deletionService.isEmailDeleted(item.email)) return null;
        return item;
      }));
      recipients.push(...eligible.filter(Boolean));
    }
    return recipients;
  }
  async deliver(id, { apiKey, fromEmail }) {
    const document = this.document(id);
    const job = await this.get(id);
    let acceptedCount = 0, excludedCount = 0;
    for (let index = 0; index < job.batchCount; index += 1) {
      const batchDocument = this.collection('mailBroadcastBatches').doc(`${id}-${index}`);
      const snapshot = await batchDocument.get();
      if (!snapshot.exists || snapshot.data().status !== 'pending') throw new Error('Invalid broadcast batch');
      const recipients = await this.currentRecipients(snapshot.data().recipients);
      excludedCount += snapshot.data().recipients.length - recipients.length;
      await batchDocument.update({ recipients });
      await document.update({ excludedCount, updatedAt: new Date(this.now()) });
      if (!recipients.length) {
        await batchDocument.update({ status: 'excluded' });
        continue;
      }
      // 外部送信前に記録する。結果が不明な送信を再実行して二重配信しない。
      await batchDocument.update({ status: 'sending' });
      await document.update({ uncertainCount: recipients.length, updatedAt: new Date(this.now()) });
      try {
        await this.requester({ apiKey, payload: {
          personalizations: recipients.map(item => ({ to: [{ email: item.email }] })),
          from: { email: fromEmail, name: 'Mojidas' }, subject: job.subject,
          content: [{ type: 'text/plain', value: job.body }],
          categories: ['mojidas-broadcast'], custom_args: { broadcast_id: id, batch: String(index) },
          tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false } },
        } });
      } catch (error) {
        const rejected = error.statusCode >= 400 && error.statusCode < 500;
        await batchDocument.update({ status: rejected ? 'rejected' : 'unknown' });
        await document.update({ status: 'attention', acceptedCount,
          uncertainCount: rejected ? 0 : recipients.length,
          rejectedCount: rejected ? recipients.length : 0, updatedAt: new Date(this.now()) });
        return;
      }
      acceptedCount += recipients.length;
      await batchDocument.update({ status: 'accepted', acceptedAt: new Date(this.now()) });
      await document.update({ acceptedCount, uncertainCount: 0, updatedAt: new Date(this.now()) });
    }
    await document.update({ status: 'completed', completedAt: new Date(this.now()), updatedAt: new Date(this.now()) });
  }
}
module.exports = new MojidasBroadcastService();
module.exports.MojidasBroadcastService = MojidasBroadcastService;
