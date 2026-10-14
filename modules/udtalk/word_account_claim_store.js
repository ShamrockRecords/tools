const crypto = require('crypto');
const firebaseAdmin = require('firebase-admin');
const { getFirestore } = require('../firestore');
const { udtalkCollection, udtalkRootPath } = require('../udtalk_firestore');
const { SendGridMailer } = require('../email/sendgrid_mailer');
const { claimReceiptMessage, claimAdminMessage, claimRecoveryMessage } = require('../email/udtalk_claim_receipt');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PAGE_SIZE = 20;
const ID_PATTERN = /^[a-f0-9]{64}$/;

class ClaimError extends Error {
  constructor(key, status = 400) {
    super(key);
    this.key = key;
    this.status = status;
  }
}

function requiredText(value, max, key) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max
      || /[\u0000-\u001f\u007f]/.test(value)) throw new ClaimError(key);
  return value.trim();
}

function normalizeClaim(body = {}) {
  const accountName = requiredText(body.accountName, 200, 'account');
  if (!/^[\x21-\x7e]+$/.test(body.accountName)) throw new ClaimError('account');
  const email = requiredText(body.email, 254, 'email');
  const confirm = requiredText(body.emailConfirmation, 254, 'email');
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email) || !emailPattern.test(confirm)) throw new ClaimError('email');
  if (email !== confirm) throw new ClaimError('emailMismatch');
  const words = [1, 2, 3].map(index => ({
    word: requiredText(body[`word${index}`], 200, 'words'),
    reading: requiredText(body[`reading${index}`], 200, 'words'),
  }));
  if (new Set(words.map(value => `${value.word}\0${value.reading}`)).size !== 3) {
    throw new ClaimError('duplicateWords');
  }
  return { accountName, email, words };
}

function validateScreenshot(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) throw new ClaimError('imageRequired');
  const data = file.buffer;
  if (data.length > MAX_IMAGE_BYTES) throw new ClaimError('imageSize', 413);
  let type;
  if (data.length > 24 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      && data.toString('ascii', 12, 16) === 'IHDR') type = 'image/png';
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) type = 'image/jpeg';
  if (data.length > 16 && data.toString('ascii', 0, 4) === 'RIFF'
      && data.toString('ascii', 8, 12) === 'WEBP') type = 'image/webp';
  if (!type || (file.mimetype && file.mimetype !== type)) throw new ClaimError('imageType');
  return { buffer: data, contentType: type, size: data.length };
}

function getBucket() {
  const name = String(process.env.UDTALK_STORAGE_BUCKET || '').trim();
  if (!name || !firebaseAdmin.apps.length) throw new Error('UDTalkの画像保存先が設定されていません。');
  return firebaseAdmin.storage().bucket(name);
}

class WordAccountClaimStore {
  constructor({ firestoreProvider = getFirestore, bucketProvider = getBucket, now = () => new Date(), mailer, adminEmail = process.env.ADMIN_EMAIL } = {}) {
    this.firestoreProvider = firestoreProvider;
    this.bucketProvider = bucketProvider;
    this.now = now;
    this.mailer = mailer;
    this.adminEmail = typeof adminEmail === 'string' ? adminEmail.trim() : '';
  }

  collection() {
    return udtalkCollection(this.firestoreProvider(), 'wordAccountClaims');
  }

  async submit(id, body, file) {
    if (!ID_PATTERN.test(id)) throw new ClaimError('formExpired', 403);
    const claim = normalizeClaim(body);
    const screenshot = validateScreenshot(file);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(claim)).update(screenshot.buffer).digest('hex');
    const ref = this.collection().doc(id);
    const existing = await ref.get();
    if (existing.exists) {
      if (existing.data().fingerprint !== fingerprint) throw new ClaimError('alreadySubmitted', 409);
      await this.sendReceipt(id);
      await this.sendAdminNotification(id);
      return id;
    }

    const bucket = this.bucketProvider();
    const path = `${udtalkRootPath()}/wordAccountClaims/${id}/screenshot`;
    const object = bucket.file(path);
    try {
      await object.save(screenshot.buffer, {
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          contentType: screenshot.contentType,
          cacheControl: 'private, no-store',
          metadata: { fingerprint },
        },
      });
    } catch (error) {
      if (Number(error.code) !== 412) throw error;
      const [metadata] = await object.getMetadata();
      if (metadata.metadata?.fingerprint !== fingerprint) throw new ClaimError('alreadySubmitted', 409);
    }

    // 保存結果が不明な場合でも画像を削除しない。同じフォームからの再送で安全に回復する。
    await this.firestoreProvider().runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) {
        if (snapshot.data().fingerprint !== fingerprint) throw new ClaimError('alreadySubmitted', 409);
        return;
      }
      transaction.create(ref, {
        ...claim,
        fingerprint,
        createdAt: this.now(),
        receiptEmail: { status: 'pending' },
        adminNotificationEmail: { status: 'pending' },
        screenshot: { path, bucket: bucket.name, contentType: screenshot.contentType, size: screenshot.size },
      });
    });
    await this.sendReceipt(id);
    await this.sendAdminNotification(id);
    return id;
  }

  async sendReceipt(id) {
    return this.sendClaimEmail(id, 'receiptEmail', claim => claimReceiptMessage(claim));
  }

  async sendAdminNotification(id) {
    if (!this.adminEmail) return;
    return this.sendClaimEmail(id, 'adminNotificationEmail', claim => claimAdminMessage(claim, this.adminEmail));
  }

  async sendClaimEmail(id, field, message) {
    try {
      const ref = this.collection().doc(id);
      const attemptedAt = this.now();
      // 送信権を永続化してからメールを送る。並行送信・再送・再起動でも同じ申請の重複送信を避ける。
      const claim = await this.firestoreProvider().runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists || snapshot.data()[field]?.status !== 'pending') return null;
        const data = snapshot.data();
        transaction.update(ref, { [field]: { status: 'sending', attemptedAt } });
        return data;
      });
      if (!claim) return;

      let result;
      try {
        // 通常の一斉メールと同じSENDGRID_API_KEY・SENDGRID_FROM_EMAILを使用する。
        const mailer = this.mailer || new SendGridMailer({ fromName: 'UDトーク' });
        await mailer.send(message({ id, accountName: claim.accountName, email: claim.email }));
        result = { status: 'sent', acceptedAt: this.now() };
      } catch (error) {
        const rejected = error.code === 'SENDGRID_NOT_CONFIGURED'
          || error.code === 'INVALID_EMAIL_MESSAGE'
          || (error.statusCode >= 400 && error.statusCode < 500);
        result = { status: rejected ? 'failed' : 'unknown', checkedAt: this.now() };
        console.warn(`UDTalk申請のメールを送信できませんでした（${field}）。`);
      }
      // 送信後の記録失敗や通信結果不明の場合は自動再送しない。申請自体は受け付け済みとする。
      await ref.update({ [field]: { ...result, attemptedAt } });
    } catch (_) {
      console.warn(`UDTalk申請のメール送信状態を確認できませんでした（${field}）。`);
    }
  }

  async sendRecovery(id) {
    if (!ID_PATTERN.test(id)) throw new ClaimError('notFound', 404);
    const ref = this.collection().doc(id);
    const attemptedAt = this.now();
    const claim = await this.firestoreProvider().runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new ClaimError('notFound', 404);
      const data = snapshot.data();
      if (data.recoveryEmail?.status === 'sending') throw new ClaimError('recoveryBusy', 409);
      transaction.update(ref, { recoveryEmail: { ...data.recoveryEmail, status: 'sending', attemptedAt } });
      return data;
    });
    try {
      const mailer = this.mailer || new SendGridMailer({ fromName: 'UDトーク' });
      await mailer.send(claimRecoveryMessage(claim.email));
    } catch (error) {
      const rejected = error.code === 'SENDGRID_NOT_CONFIGURED' || error.code === 'INVALID_EMAIL_MESSAGE'
        || (error.statusCode >= 400 && error.statusCode < 500);
      await ref.update({ recoveryEmail: { ...claim.recoveryEmail, status: rejected ? 'failed' : 'unknown', attemptedAt } });
      throw new ClaimError('recoverySend', 503);
    }
    await ref.update({ recoveryEmail: { status: 'sent', attemptedAt, acceptedAt: this.now() } });
  }

  async list(after) {
    let query = this.collection().orderBy('createdAt', 'desc');
    if (after) {
      if (typeof after !== 'string' || !ID_PATTERN.test(after)) throw new ClaimError('page', 400);
      const cursor = await this.collection().doc(after).get();
      if (!cursor.exists) throw new ClaimError('page', 400);
      query = query.startAfter(cursor);
    }
    const snapshot = await query.limit(PAGE_SIZE + 1).get();
    const rows = snapshot.docs.slice(0, PAGE_SIZE).map(doc => ({ id: doc.id, ...doc.data() }));
    return { rows, next: snapshot.docs.length > PAGE_SIZE ? rows[rows.length - 1].id : null };
  }

  async screenshot(id) {
    if (!ID_PATTERN.test(id)) throw new ClaimError('notFound', 404);
    const snapshot = await this.collection().doc(id).get();
    if (!snapshot.exists) throw new ClaimError('notFound', 404);
    const stored = snapshot.data().screenshot;
    const bucket = this.bucketProvider();
    if (stored.bucket !== bucket.name || stored.path !== `${udtalkRootPath()}/wordAccountClaims/${id}/screenshot`
        || !['image/png', 'image/jpeg', 'image/webp'].includes(stored.contentType)) {
      throw new Error('UDTalkの画像情報が正しくありません。');
    }
    const [buffer] = await bucket.file(stored.path).download();
    return { buffer, contentType: stored.contentType };
  }
}

module.exports = { ClaimError, ID_PATTERN, MAX_IMAGE_BYTES, WordAccountClaimStore, normalizeClaim, validateScreenshot };
