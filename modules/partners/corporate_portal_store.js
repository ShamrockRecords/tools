const crypto = require('crypto');
const { getFirestore } = require('../firestore');
const { mojidasCollection } = require('../mojidas_firestore');
const { createAdminPasswordHash, verifyPassword } = require('../auth/admin_credentials');
const { SendGridMailer } = require('../email/sendgrid_mailer');
const { displayState } = require('./domain_lifecycle');

const URL = 'https://app.mojidas.jp/corporate';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const emailOf = value => String(value || '').trim().toLowerCase();
const fail = message => new Error(message);
const validPassword = value => typeof value === 'string' && value.length >= 12 && value.length <= 128;
const dummyHash = createAdminPasswordHash('corporate-login-dummy-password');

class CorporatePortalStore {
  constructor({ firestoreProvider = getFirestore, now = Date.now, mailer, secret = () => process.env.SESSION_SECRET } = {}) {
    this.provider = firestoreProvider; this.now = now; this.mailer = mailer; this.secret = secret;
  }
  collection(name) { return mojidasCollection(this.provider(), name); }
  key() {
    const secret = this.secret();
    if (!secret || secret.length < 32) throw fail('法人ポータルには32文字以上のSESSION_SECRETが必要です。');
    return crypto.createHash('sha256').update(`corporate-portal:${secret}`).digest();
  }
  encrypt(value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  decrypt(value) {
    const bytes = Buffer.from(value, 'base64');
    const cipher = crypto.createDecipheriv('aes-256-gcm', this.key(), bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
  }
  send(to, subject, text) {
    const mailer = this.mailer || new SendGridMailer({ fromEmail: process.env.MOJIDAS_AUTH_FROM_EMAIL || 'no-reply@mojidas.jp', fromName: 'Mojidas' });
    return mailer.send({ to, subject, text, categories: ['mojidas-corporate-portal'] });
  }
  // 呼び出し元のドメイン変更と同じtransaction。呼び出し前に必要なreadを完了させる。
  async provision(tx, domain) {
    if (domain.portalAccountID || domain.status !== 'approved') return {};
    const email = emailOf(domain.contactEmail);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      throw fail('有効化するには、詳細で法人ポータルの送信先となる連絡先メールアドレスを登録してください。');
    const id = hash(email), ref = this.collection('corporatePortalAccounts').doc(id);
    const existing = await tx.get(ref);
    if (!existing.exists) {
      const temporary = crypto.randomBytes(18).toString('base64url');
      tx.set(ref, { email, passwordHash: createAdminPasswordHash(temporary), mustChangePassword: true,
        version: 1, createdAt: this.now(), failedLogins: 0, lockedUntil: 0,
        invitation: this.encrypt(temporary), invitationStatus: 'pending', invitationLeaseUntil: 0 });
    }
    return { portalAccountID: id, portalCreatedAt: this.now(), portalLoginEmail: email };
  }
  async deliverForDomain(domain) {
    const row = await this.collection('corporateDomains').doc(domain).get();
    if (!row.exists || !row.data().portalAccountID) return;
    const ref = this.collection('corporatePortalAccounts').doc(row.data().portalAccountID);
    const lease = crypto.randomBytes(16).toString('hex');
    const account = await this.provider().runTransaction(async tx => {
      const snapshot = await tx.get(ref), data = snapshot.data();
      if (!data?.invitation || data.invitationStatus === 'sent') return null;
      if (data.invitationLeaseUntil > this.now()) throw fail('案内メールを送信中です。時間をおいて再確認してください。');
      tx.update(ref, { invitationLease: lease, invitationLeaseUntil: this.now() + 60000 });
      return data;
    });
    if (!account) return;
    try {
      await this.send(account.email, 'Mojidas 法人向けポータルのご案内',
        `法人向けポータルをご利用いただけます。\n${URL}\nログインメールアドレス：${account.email}\n仮パスワード：${this.decrypt(account.invitation)}\n\n初回はメールに届く6桁の認証コードを入力し、新しいパスワードを設定してください。Mojidasアプリとは別のアカウントです。\n心当たりがない場合は管理者へお問い合わせください。`);
      await this.provider().runTransaction(async tx => {
        const current = await tx.get(ref);
        if (current.data()?.invitationLease === lease) tx.update(ref, {
          invitation: null, invitationStatus: 'sent', invitationSentAt: this.now(), invitationLeaseUntil: 0,
        });
      });
    } catch (_) {
      await this.provider().runTransaction(async tx => {
        const current = await tx.get(ref);
        if (current.data()?.invitationLease === lease) tx.update(ref, { invitationStatus: 'failed', invitationLeaseUntil: 0 });
      });
      throw fail('ドメインとポータルは保存済みですが、案内メールを送信できませんでした。詳細の「ポータル案内を再送」から再試行してください。');
    }
  }
  async login(email, password) {
    const id = hash(emailOf(email)), ref = this.collection('corporatePortalAccounts').doc(id);
    const first = await ref.get(), data = first.data();
    const matches = typeof password === 'string' && password.length <= 128
      && verifyPassword(password, data?.passwordHash || dummyHash);
    const result = await this.provider().runTransaction(async tx => {
      const current = await tx.get(ref), row = current.data();
      if (!row || row.lockedUntil > this.now()) return null;
      if (!matches || row.passwordHash !== data?.passwordHash) {
        const failures = (row.failedLogins || 0) + 1;
        tx.update(ref, { failedLogins: failures >= 5 ? 0 : failures,
          lockedUntil: failures >= 5 ? this.now() + 15 * 60000 : 0 });
        return null;
      }
      tx.update(ref, { failedLogins: 0, lockedUntil: 0 });
      return { id, email: row.email, version: row.version, mustChangePassword: row.mustChangePassword };
    });
    if (!result) throw fail('メールアドレスまたはパスワードを確認してください。');
    return result;
  }
  codeHash(id, code) { return crypto.createHmac('sha256', this.key()).update(`${id}:${code}`).digest('hex'); }
  async challenge(login) {
    const id = crypto.randomBytes(24).toString('hex'), code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const ref = this.collection('corporatePortalChallenges').doc(id);
    await this.provider().runTransaction(async tx => {
      const accountRef = this.collection('corporatePortalAccounts').doc(login.id);
      const row = (await tx.get(accountRef)).data();
      if (!row?.mustChangePassword || row.version !== login.version) throw fail('ログインからやり直してください。');
      if (row.codeSentAt && this.now() - row.codeSentAt < 60000) throw fail('認証コードの再送は1分以上あけてください。');
      tx.set(ref, { accountID: login.id, version: login.version, codeHash: this.codeHash(id, code),
        expiresAt: this.now() + 10 * 60000, attempts: 0, verified: false });
      tx.update(accountRef, { codeSentAt: this.now(), latestChallengeID: id });
    });
    try { await this.send(login.email, 'Mojidas 法人向けポータルの認証コード', `認証コード：${code}\n有効期限は10分です。\n心当たりがない場合は入力しないでください。`); }
    catch (_) { await ref.delete(); throw fail('認証コードを送信できませんでした。1分後に再度ログインしてください。'); }
    return id;
  }
  async verifyCode(login, id, code) {
    if (typeof id !== 'string' || !/^[a-f0-9]{48}$/.test(id)) throw fail('ログインからやり直してください。');
    const result = await this.provider().runTransaction(async tx => {
      const ref = this.collection('corporatePortalChallenges').doc(id);
      const row = (await tx.get(ref)).data();
      const account = (await tx.get(this.collection('corporatePortalAccounts').doc(login.id))).data();
      if (!row || row.accountID !== login.id || row.version !== login.version || row.verified
        || row.expiresAt <= this.now() || row.attempts >= 5 || account?.version !== login.version
        || account.latestChallengeID !== id) return false;
      const valid = typeof code === 'string' && /^\d{6}$/.test(code) && row.codeHash === this.codeHash(id, code);
      tx.update(ref, { attempts: row.attempts + 1, ...(valid ? { verified: true, codeHash: null } : {}) });
      return valid;
    });
    if (!result) throw fail('認証コードが無効、期限切れ、または試行回数の上限に達しています。再度ログインしてください。');
  }
  async account(login, allowTemporary = false) {
    if (!login || !/^[a-f0-9]{64}$/.test(login.id || '')) return null;
    const row = (await this.collection('corporatePortalAccounts').doc(login.id).get()).data();
    if (!row || row.version !== login.version || (!allowTemporary && row.mustChangePassword)) return null;
    return { id: login.id, email: row.email, version: row.version, mustChangePassword: row.mustChangePassword };
  }
  async changePassword(login, { password, currentPassword, challengeID }) {
    if (!validPassword(password)) throw fail('新しいパスワードは12〜128文字で入力してください。');
    const ref = this.collection('corporatePortalAccounts').doc(login.id);
    const before = (await ref.get()).data();
    if (!before || before.version !== login.version) throw fail('再度ログインしてください。');
    if (verifyPassword(password, before.passwordHash)) throw fail('これまでと異なるパスワードを設定してください。');
    if (!before.mustChangePassword && (typeof currentPassword !== 'string' || currentPassword.length > 128
      || !verifyPassword(currentPassword, before.passwordHash))) throw fail('現在のパスワードを確認してください。');
    const passwordHash = createAdminPasswordHash(password);
    return this.provider().runTransaction(async tx => {
      const row = (await tx.get(ref)).data();
      if (!row || row.version !== login.version || row.passwordHash !== before.passwordHash) throw fail('再度ログインしてください。');
      let challengeRef;
      if (row.mustChangePassword) {
        if (!/^[a-f0-9]{48}$/.test(challengeID || '')) throw fail('メール認証が必要です。');
        challengeRef = this.collection('corporatePortalChallenges').doc(challengeID);
        const challenge = (await tx.get(challengeRef)).data();
        if (!challenge?.verified || challenge.accountID !== login.id || challenge.version !== row.version
          || challenge.expiresAt <= this.now() || row.latestChallengeID !== challengeID) throw fail('メール認証からやり直してください。');
      }
      tx.update(ref, { passwordHash, mustChangePassword: false, version: row.version + 1,
        invitation: null, invitationStatus: 'sent', passwordChangedAt: this.now(), latestChallengeID: null });
      if (challengeRef) tx.delete(challengeRef);
      return { id: login.id, email: row.email, version: row.version + 1, mustChangePassword: false };
    });
  }
  async dashboard(login) {
    const snapshot = await this.collection('corporateDomains').where('portalAccountID', '==', login.id).get();
    return snapshot.docs.map(doc => {
      const row = doc.data();
      return { domain: doc.id, organizationName: row.organizationName, plan: row.plan || 'custom', status: displayState(row, this.now()) };
    });
  }
}
module.exports = { CorporatePortalStore };
module.exports.corporatePortalStore = new CorporatePortalStore();
