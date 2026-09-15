const crypto = require('crypto');
const { getFirestore } = require('../firestore');
const { mojidasCollection } = require('../mojidas_firestore');
const { normalizeDomain, isSharedDomain } = require('./domain_policy');
const { createAdminPasswordHash, verifyPassword } = require('../auth/admin_credentials');
const { SendGridMailer } = require('../email/sendgrid_mailer');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const emailValue = value => String(value || '').trim().toLowerCase();
const textValue = (value, max) => String(value || '').trim().slice(0, max);

class PartnerStore {
  constructor({ firestoreProvider = getFirestore, now = Date.now, mailer } = {}) {
    this.provider = firestoreProvider; this.now = now; this.mailer = mailer;
  }
  collection(name) { return mojidasCollection(this.provider(), name); }
  async entitlement(user) {
    if (!user || !user.emailVerified || user.disabled) return null;
    const domain = normalizeDomain(String(user.email || '').split('@')[1]);
    if (!domain || isSharedDomain(domain)) return null;
    const snapshot = await this.collection('corporateDomains').doc(domain).get();
    if (!snapshot.exists || snapshot.data().status !== 'approved') return null;
    const data = snapshot.data();
    const partner = await this.collection('partners').doc(data.partnerID).get();
    if (!partner.exists || partner.data().status !== 'active') return null;
    return { domain, partnerID: data.partnerID, organizationName: data.organizationName };
  }
  async invite(email, name) {
    email = emailValue(email); name = textValue(name, 120);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !name)
      throw fail('INVALID_PARTNER', '販売店名とメールアドレスを確認してください。');
    const id = hash(email), token = crypto.randomBytes(32).toString('hex');
    const ref = this.collection('partners').doc(id);
    await this.provider().runTransaction(async tx => {
      const previous = await tx.get(ref);
      if (previous.exists && previous.data().status === 'active')
        throw fail('PARTNER_EXISTS', 'この販売店は登録済みです。');
      tx.set(ref, { email, name, status: 'invited', inviteHash: hash(token),
        inviteExpiresAt: this.now() + 24 * 60 * 60 * 1000, createdAt: this.now() });
    });
    const url = `https://app.mojidas.jp/partners/accept#id=${id}&token=${token}`;
    const mailer = this.mailer || new SendGridMailer({
      fromEmail: process.env.MOJIDAS_AUTH_FROM_EMAIL || 'no-reply@mojidas.jp', fromName: 'Mojidas',
    });
    await mailer.send({ to: email, subject: 'Mojidas 販売店アカウントへの招待',
      text: `販売店アカウントへ招待されました。次のURLからパスワードを設定してください（24時間有効）。\n${url}\n心当たりがない場合は操作しないでください。`,
      html: `<p>販売店アカウントへ招待されました。</p><p><a href="${url}">パスワードを設定する</a>（24時間有効）</p>`,
      categories: ['mojidas-partners'],
    });
    return id;
  }
  async accept(id, token, password) {
    if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{64}$/.test(token)
        || typeof password !== 'string' || password.length < 8 || password.length > 128)
      throw fail('INVALID_INVITE', '招待情報と8〜128文字のパスワードを確認してください。');
    const passwordHash = createAdminPasswordHash(password);
    return this.provider().runTransaction(async tx => {
      const ref = this.collection('partners').doc(id), snapshot = await tx.get(ref);
      const data = snapshot.exists && snapshot.data();
      if (!data || data.status !== 'invited' || data.inviteExpiresAt <= this.now()
          || data.inviteHash !== hash(token)) throw fail('INVALID_INVITE', '招待が無効か期限切れです。');
      tx.update(ref, { passwordHash, status: 'active', inviteHash: null, inviteExpiresAt: null });
      return id;
    });
  }
  async login(email, password) {
    const id = hash(emailValue(email)), snapshot = await this.collection('partners').doc(id).get();
    const data = snapshot.exists && snapshot.data();
    if (typeof password !== 'string' || password.length > 128 || !data || data.status !== 'active'
        || !verifyPassword(password, data.passwordHash)) throw fail('LOGIN_FAILED', 'ログインできませんでした。');
    return id;
  }
  async activePartner(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return null;
    const snapshot = await this.collection('partners').doc(id).get();
    if (!snapshot.exists || snapshot.data().status !== 'active') return null;
    return { id, name: snapshot.data().name, email: snapshot.data().email };
  }
  async submit(partnerID, input) {
    const domain = normalizeDomain(input.domain), organizationName = textValue(input.organizationName, 160);
    if (!domain || isSharedDomain(domain) || !organizationName)
      throw fail('INVALID_DOMAIN', '組織名・独自ドメインを確認してください。');
    await this.provider().runTransaction(async tx => {
      const partner = await tx.get(this.collection('partners').doc(partnerID));
      const ref = this.collection('corporateDomains').doc(domain), previous = await tx.get(ref);
      if (!partner.exists || partner.data().status !== 'active') throw fail('FORBIDDEN', '販売店が無効です。');
      if (previous.exists) throw fail('DOMAIN_EXISTS', 'このドメインは申請済みです。管理者へお問い合わせください。');
      tx.set(ref, { domain, partnerID, organizationName,
        status: 'pending', submittedAt: this.now(), approvedAt: null });
    });
  }
  async review(domain, status, adminEmail) {
    if (normalizeDomain(domain) !== domain || !['approved', 'rejected', 'suspended'].includes(status))
      throw fail('INVALID_REVIEW', '承認内容を確認してください。');
    await this.provider().runTransaction(async tx => {
      const ref = this.collection('corporateDomains').doc(domain), snapshot = await tx.get(ref);
      if (!snapshot.exists) throw fail('NOT_FOUND', '申請がありません。');
      const partner = await tx.get(this.collection('partners').doc(snapshot.data().partnerID));
      if (status === 'approved' && (isSharedDomain(domain) || !partner.exists || partner.data().status !== 'active'))
        throw fail('FORBIDDEN', '有効な販売店の独自ドメインのみ承認できます。');
      tx.update(ref, { status, reviewedBy: adminEmail, reviewedAt: this.now(),
        approvedAt: status === 'approved' ? this.now() : snapshot.data().approvedAt });
    });
  }
  async updateDomain(partnerID, input) {
    const domain = normalizeDomain(input.domain);
    const name = typeof input.organizationName === 'string' ? input.organizationName.trim() : '';
    const email = typeof input.contactEmail === 'string' ? input.contactEmail.trim() : '';
    const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
    if (!domain || !name || name.length > 160 || email.length > 254 || notes.length > 5000
        || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
      throw fail('INVALID_DOMAIN', '組織名・連絡先メールアドレス・備考を確認してください。');
    await this.provider().runTransaction(async tx => {
      const ref = this.collection('corporateDomains').doc(domain);
      const row = await tx.get(ref);
      if (!row.exists || (partnerID !== null && row.data().partnerID !== partnerID))
        throw fail('FORBIDDEN', 'このドメインは編集できません。');
      if (partnerID !== null) {
        const dealer = await tx.get(this.collection('partners').doc(partnerID));
        if (!dealer.exists || dealer.data().status !== 'active') throw fail('FORBIDDEN', '販売店が無効です。');
      }
      // 承認状態・所有者・利用時間には触れない。
      tx.update(ref, { organizationName: name, contactEmail: email, notes });
    });
  }
  async dashboard(partnerID, month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw fail('INVALID_MONTH', '対象月を確認してください。');
    let domains = this.collection('corporateDomains');
    if (partnerID) domains = domains.where('partnerID', '==', partnerID);
    const domainRows = await domains.get();
    // 閲覧可能なドメインの指定月だけを読む。過去全月・他店・会員情報は読まない。
    return Promise.all(domainRows.docs.map(async row => {
      const data = row.data();
      const snapshot = await this.collection('corporateUsageMonths').doc(`${data.partnerID}_${row.id}_${month}`).get();
      const usage = snapshot.exists ? snapshot.data() : {};
      return { ...data, id: row.id, usage: { realtime: usage.realtime || 0,
        mediaFile: usage.mediaFile || 0, formalTranslation: usage.formalTranslation || 0 } };
    }));
  }
  async updateName(id, name) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)
        || typeof name !== 'string' || !name.trim() || name.trim().length > 120)
      throw fail('INVALID_PARTNER', '販売店名を1〜120文字で入力してください。');
    const ref = this.collection('partners').doc(id);
    await this.provider().runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw fail('INVALID_PARTNER', '販売店が見つかりません。');
      // ログイン情報・招待情報・ドメインとの紐付けは変更しない。
      tx.update(ref, { name: name.trim() });
    });
  }
  async listPartners() {
    const result = await this.collection('partners').get();
    return result.docs.map(row => ({ id: row.id, name: row.data().name, email: row.data().email, status: row.data().status }));
  }
}

module.exports = new PartnerStore();
module.exports.PartnerStore = PartnerStore;
