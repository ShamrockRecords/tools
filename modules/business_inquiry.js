const crypto = require('crypto');
const { getFirestore } = require('./firestore');
const { mojidasCollection } = require('./mojidas_firestore');
const { normalizeDomain, isSharedDomain } = require('./partners/domain_policy');
const { SendGridMailer } = require('./email/sendgrid_mailer');
const { parseDate } = require('./partners/domain_lifecycle');

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function validateInquiry(body = {}, { general = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('入力内容をご確認ください。');
  const field = (key, max, required = true) => {
    const value = body[key];
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid('入力内容をご確認ください。');
    return value.trim();
  };
  const requestID = field('requestID', 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestID)) invalid('受付番号が正しくありません。ページを再読み込みしてください。');
  if (body.website) invalid('送信を受け付けられませんでした。');
  const organization = general && body.organization === undefined ? '' : field('organization', 200, !general);
  const name = field('name', 100);
  const referringPartner = !general && body.referringPartner !== undefined ? field('referringPartner', 200, false) : '';
  if (/[\x00-\x1f\x7f]/.test(referringPartner)) invalid('販売店名は1行で入力してください。');
  if (/[\r\n\x00-\x1f]/.test(organization + name)) invalid('法人・団体名と担当者名は1行で入力してください。');
  const email = field('email', 254);
  if (email !== field('emailConfirmation', 254)) invalid('メールアドレスが一致しません。');
  const parts = email.split('@');
  const domain = parts.length === 2 ? normalizeDomain(parts[1]) : null;
  if (!domain || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(parts[0]) || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..')) invalid('有効なメールアドレスを入力してください。');
  if (!general && isSharedDomain(domain)) invalid('Gmail・Yahoo!などの共用メールは利用できません。企業・団体の独自ドメインのメールアドレスでお申し込みください。');
  const message = field('message', 5000, general);
  if (message.includes('\0')) invalid('内容に使用できない文字が含まれています。');
  const category = body.category === undefined ? 'general' : body.category;
  if (general && !['general', 'corporate'].includes(category)) invalid('お問い合わせの種類を選択してください。');
  if (general && category === 'corporate' && !organization) invalid('法人・団体名を入力してください。');
  let trialPeriod = {};
  if (!general) {
    const trialStartsAt = field('trialStartsAt', 16);
    const start = parseDate(trialStartsAt);
    if (!Number.isFinite(start)) invalid('トライアル開始日時を正しく入力してください。');
    // 日本時間の暦で1か月を加算し、翌月に同じ日がなければ月末に丸める。
    const end = new Date(start + 9 * 3600000), day = end.getUTCDate();
    end.setUTCDate(1); end.setUTCMonth(end.getUTCMonth() + 1);
    const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
    end.setUTCDate(Math.min(day, last));
    if (end.getUTCFullYear() > 9999) invalid('トライアル開始日時を正しく入力してください。');
    trialPeriod = { trialStartsAt, trialEndsAt: end.toISOString().slice(0, 16) };
  }
  return { requestID: requestID.toLowerCase(), organization, name, email: `${parts[0]}@${domain}`, domain, message, ...(general ? { category } : {}), ...(referringPartner ? { referringPartner } : {}), ...trialPeriod };
}

// 宛先ごとの受付状態を保存し、二重クリック・再送で受付済みメールを再送しない。
// タイムアウトやプロセス停止時は配達状態が不明なため自動再送しない。
class InquiryStore {
  constructor({ firestore, general = false } = {}) { this.firestore = firestore; this.collectionName = general ? 'contactInquiries' : 'businessInquiries'; }
  database() { return this.firestore || getFirestore(); }
  collection() { return mojidasCollection(this.database(), this.collectionName); }
  async create(data) {
    const ref = this.collection().doc(data.requestID);
    const hash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
    await this.database().runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      if (snapshot.exists) {
        if (snapshot.data().hash !== hash) {
          const error = new Error('受付番号が重複しています。ページを再読み込みしてください。');
          error.status = 409; throw error;
        }
        return;
      }
      // 元の入力と再送判定用hashを維持し、紹介元は受付の備考として保存する。
      const notes = this.collectionName === 'businessInquiries' && data.referringPartner
        ? [data.message, `紹介販売店：${data.referringPartner}`].filter(Boolean).join('\n\n') : null;
      const createdAt = Date.now();
      if (this.collectionName === 'businessInquiries') {
        const domainRef = mojidasCollection(this.database(), 'corporateDomains').doc(data.domain);
        const existing = await tx.get(domainRef);
        if (existing.exists) {
          const error = new Error('このドメインのお申し込みは個別に確認が必要です。app@mojidas.jp へお問い合わせください。');
          error.status = 409; throw error;
        }
        const start = parseDate(data.trialStartsAt), end = parseDate(data.trialEndsAt);
        if (!Number.isFinite(start) || !Number.isFinite(end)) invalid('トライアル開始日時を確認してください。');
        // 受付と無効状態の法人ドメインを同時保存し、成功後だけメール送信する。
        tx.create(domainRef, { domain: data.domain, partnerID: 'self', plan: 'trial', status: 'suspended',
          hasValidityPeriod: true, validityStartsAt: start, validityEndsAt: end,
          organizationName: data.organization, contactEmail: data.email,
          notes: data.referringPartner ? `紹介販売店：${data.referringPartner}` : '',
          createdAt, createdBy: 'trial-inquiry', trialInquiryID: data.requestID,
          limitMilliseconds: 10 * 3600000, stopAtLimit: true, notifyAtOneHour: false,
          resetDay: new Date(start + 9 * 3600000).getUTCDate() });
      }
      tx.create(ref, { ...data, ...(notes !== null ? { notes } : {}), hash, createdAt: new Date(createdAt), admin: 'pending', customer: 'pending' });
    });
  }
  async claim(id, recipient) {
    const ref = this.collection().doc(id);
    return this.database().runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      const state = snapshot.data()[recipient];
      if (!['pending', 'failed'].includes(state)) return false;
      tx.update(ref, { [recipient]: 'sending', updatedAt: new Date() });
      return true;
    });
  }
  async finish(id, recipient, state) {
    await this.collection().doc(id).update({ [recipient]: state, updatedAt: new Date() });
  }
  async read(id) { return (await this.collection().doc(id).get()).data(); }
}

function createInquiryService({ general = false, store = new InquiryStore({ general }), mailer = new SendGridMailer({ fromEmail: 'no-reply@mojidas.jp', fromName: 'Mojidas' }) } = {}) {
  return async data => {
    await store.create(data);
    const contactKind = data.category === 'corporate' ? '法人向けプランについてのお問い合わせ' : '一般的なお問い合わせ';
    const details = [
      `受付番号：${data.requestID}`, ...(!general || data.category === 'corporate' ? [`法人・団体名：${data.organization}`] : []), `${general && data.category !== 'corporate' ? 'お名前' : '担当者名'}：${data.name}`,
      `メールアドレス：${data.email}`, `ドメイン：${data.domain}`,
      ...(!general && data.trialStartsAt ? [`トライアル開始日時：${data.trialStartsAt.replace('T', ' ')}（日本時間）`, `有効期限：${data.trialEndsAt.replace('T', ' ')}（日本時間・開始日時から1か月間）`] : []),
      ...(general ? [`お問い合わせの種類：${contactKind}`] : []),
      '', '内容：', data.message || '（なし）',
      ...(!general && data.referringPartner ? ['', '備考：', `紹介販売店：${data.referringPartner}`] : []),
    ].join('\n');
    for (const recipient of ['admin', 'customer']) {
      if (!await store.claim(data.requestID, recipient)) continue;
      try {
        await mailer.send({
          to: recipient === 'admin' ? 'app@mojidas.jp' : data.email,
          ...(recipient === 'admin' ? { replyTo: data.email } : {}),
          subject: general
            ? (recipient === 'admin' ? `Mojidas ${contactKind}` : `Mojidas ${contactKind} 受付内容のご確認`)
            : (recipient === 'admin' ? 'Mojidas 法人向けトライアル申し込み' : 'Mojidas 法人向けトライアル 受付内容のご確認'),
          text: recipient === 'admin' ? [!general ? 'トライアルの申し込みがありました。法人ドメインを「自社／トライアル／無効」で登録しました。内容とドメイン所有者を確認のうえ、管理画面で有効にしてください。\n' : '', details].filter(Boolean).join('\n') : [
            general ? 'Mojidasへのお問い合わせを受け付けました。' : 'Mojidas法人向けトライアルのお申し込みを受け付けました。',
            '以下の内容を確認のうえ、担当者からご連絡します。',
            ...(!general ? ['このメールは受付のご案内です。トライアルはまだ有効になっていません。内容確認後、担当者よりご案内します。'] : []),
            '', details, '', 'このメールは送信専用です。お問い合わせは app@mojidas.jp までお願いいたします。',
            'お心当たりがない場合は、このメールを破棄してください。',
          ].join('\n'),
          categories: [general ? 'mojidas-contact-inquiry' : 'mojidas-business-inquiry'],
        });
        await store.finish(data.requestID, recipient, 'accepted');
      } catch (error) {
        const rejected = error.code === 'SENDGRID_NOT_CONFIGURED' || (error.statusCode >= 400 && error.statusCode < 500);
        await store.finish(data.requestID, recipient, rejected ? 'failed' : 'unknown');
      }
    }
    const record = await store.read(data.requestID);
    if (record.admin === 'failed' || record.customer === 'failed') {
      const error = new Error('受付内容は保存しましたが、メール送信に失敗しました。時間をおいて再度送信してください。改善しない場合は app@mojidas.jp へ受付番号を添えてご連絡ください。');
      error.status = 503; throw error;
    }
    return { message: record.admin === 'accepted' && record.customer === 'accepted'
      ? (general ? 'お問い合わせを受け付けました。確認メールをご確認ください。' : 'トライアルのお申し込みを受け付けました。確認メールをご確認ください。')
      : '受付内容は保存しましたが、メールの送信結果を確認できませんでした。確認メールが届かない場合は、app@mojidas.jp へ受付番号を添えてご連絡ください。' };
  };
}

module.exports = { validateInquiry, InquiryStore, createInquiryService };
