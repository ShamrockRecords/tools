const crypto = require('crypto');
const { deletionState } = require('./domain_deletion');
const { getFirestore } = require('../firestore');
const { mojidasCollection } = require('../mojidas_firestore');
const { normalizeDomain, isSharedDomain } = require('./domain_policy');
const { createAdminPasswordHash, verifyPassword } = require('../auth/admin_credentials');
const { SendGridMailer } = require('../email/sendgrid_mailer');
const { parseQuota, resetDay, boundary, quotaStatus, periodAt } = require('./quota_policy');
const { readQuota, saveQuota, totalUsage } = require('./quota_store');
const { monthAt } = require('./usage_policy');
const { SELF_PARTNER_ID, parseLifecycle, displayState, refreshDomain } = require('./domain_lifecycle');
const { CorporatePortalStore } = require('./corporate_portal_store');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const emailValue = value => String(value || '').trim().toLowerCase();
const textValue = (value, max) => String(value || '').trim().slice(0, max);

class PartnerStore {
  constructor({ firestoreProvider = getFirestore, now = Date.now, mailer, portalStore } = {}) {
    this.provider = firestoreProvider; this.now = now; this.mailer = mailer;
    this.portal = portalStore === undefined ? new CorporatePortalStore({ firestoreProvider, now, mailer }) : portalStore;
  }
  collection(name) { return mojidasCollection(this.provider(), name); }
  async entitlement(user) {
    if (!user || !user.emailVerified || user.disabled) return null;
    const domain = normalizeDomain(String(user.email || '').split('@')[1]);
    if (!domain || isSharedDomain(domain)) return null;
    const data = await refreshDomain(this.provider(), domain, this.now());
    if (!data || displayState(data, this.now()) !== 'active') return null;
    if (data.partnerID !== SELF_PARTNER_ID) {
      const partner = await this.collection('partners').doc(data.partnerID).get();
      if (!partner.exists || partner.data().status !== 'active') return null;
    }
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
      if (previous.exists && (previous.data().status !== 'invited' || previous.data().passwordHash))
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
  async setPartnerStatus(id, state, adminEmail) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || !['active', 'inactive'].includes(state))
      throw fail('INVALID_PARTNER', '販売店と有効／無効を確認してください。');
    await this.provider().runTransaction(async tx => {
      const ref = this.collection('partners').doc(id), snapshot = await tx.get(ref);
      if (!snapshot.exists) throw fail('NOT_FOUND', '販売店が見つかりません。');
      const data = snapshot.data();
      if (!['active', 'suspended'].includes(data.status) || !data.passwordHash)
        throw fail('INVITE_PENDING', '先に招待メールからパスワード設定を完了してください。');
      const status = state === 'active' ? 'active' : 'suspended';
      if (data.status === status) return;
      // 状態のみ変更し、ログイン情報・ドメイン設定・利用履歴は保持する。
      tx.update(ref, { status, statusUpdatedBy: adminEmail, statusUpdatedAt: this.now() });
    });
  }
  async addDomain(partnerID, input, adminEmail) {
    if (typeof partnerID !== 'string' || (partnerID !== SELF_PARTNER_ID && !/^[a-f0-9]{64}$/.test(partnerID)))
      throw fail('INVALID_PARTNER', '販売店を選択してください。');
    const domain = normalizeDomain(input.domain), organizationName = textValue(input.organizationName, 200);
    if (!domain || isSharedDomain(domain) || !organizationName)
      throw fail('INVALID_DOMAIN', '組織名・独自ドメインを確認してください。');
    const lifecycle = parseLifecycle(input);
    await this.provider().runTransaction(async tx => {
      const partner = partnerID === SELF_PARTNER_ID ? null : await tx.get(this.collection('partners').doc(partnerID));
      const ref = this.collection('corporateDomains').doc(domain), previous = await tx.get(ref);
      if (partnerID !== SELF_PARTNER_ID && (!partner.exists || partner.data().status !== 'active')) throw fail('FORBIDDEN', '販売店が無効です。');
      if (previous.exists) throw fail('DOMAIN_EXISTS', 'このドメインは登録済みです。');
      const createdAt = this.now();
      const data = { domain, partnerID, organizationName, contactEmail: emailValue(input.contactEmail),
        ...lifecycle, status: lifecycle.hasValidityPeriod && createdAt >= lifecycle.validityEndsAt ? 'suspended' : lifecycle.status, createdAt, approvedAt: createdAt,
        resetDay: resetDay({ approvedAt: createdAt }), createdBy: adminEmail };
      const portal = this.portal ? await this.portal.provision(tx, data) : {};
      tx.set(ref, { ...data, ...portal });
    });
    if (this.portal) await this.portal.deliverForDomain(domain);
  }
  async setDomainStatus(domain, state, adminEmail) {
    if (normalizeDomain(domain) !== domain || !['active', 'inactive'].includes(state))
      throw fail('INVALID_STATUS', '有効または無効を選択してください。');
    // 既存の課金判定・利用期間との互換性を保つ保存値。
    const status = state === 'active' ? 'approved' : 'suspended';
    await this.provider().runTransaction(async tx => {
      const ref = this.collection('corporateDomains').doc(domain), snapshot = await tx.get(ref);
      if (!snapshot.exists) throw fail('NOT_FOUND', 'ドメインが登録されていません。');
      const self = snapshot.data().partnerID === SELF_PARTNER_ID;
      const partner = self ? null : await tx.get(this.collection('partners').doc(snapshot.data().partnerID));
      if (status === 'approved' && (isSharedDomain(domain) || (!self && (!partner.exists || partner.data().status !== 'active'))))
        throw fail('FORBIDDEN', '有効な販売店の独自ドメインのみ有効にできます。');
      if (status === 'approved' && snapshot.data().hasValidityPeriod && this.now() >= snapshot.data().validityEndsAt)
        throw fail('INVALID_STATUS', '有効期間が終了しているため有効にできません。');
      const portal = this.portal ? await this.portal.provision(tx, { ...snapshot.data(), status }) : {};
      tx.update(ref, { ...portal, status, reviewedBy: adminEmail, reviewedAt: this.now(),
        ...(status === 'approved' && !snapshot.data().approvedAt
          ? { resetDay: snapshot.data().resetDay || resetDay({ approvedAt: this.now() }) } : {}),
        approvedAt: status === 'approved' ? (snapshot.data().approvedAt || this.now()) : snapshot.data().approvedAt });
    });
    if (this.portal && status === 'approved') await this.portal.deliverForDomain(domain);
  }
  async updateDomain(partnerID, input) {
    const domain = normalizeDomain(input.domain);
    const name = typeof input.organizationName === 'string' ? input.organizationName.trim() : '';
    const email = typeof input.contactEmail === 'string' ? input.contactEmail.trim() : '';
    const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
    const quota = input.resetDay === undefined ? null : parseQuota(input);
    const contractFields = ['plan', 'validityPeriod', 'validityStartsAt', 'validityEndsAt', 'status', 'partnerID'];
    if (partnerID !== null && contractFields.some(key => input[key] !== undefined))
      throw fail('FORBIDDEN', '契約設定は管理者のみ変更できます。');
    const lifecycle = input.plan === undefined ? null : parseLifecycle(input);
    if (lifecycle?.status === 'approved' && isSharedDomain(domain))
      throw fail('INVALID_DOMAIN', '企業・団体の独自ドメインを指定してください。');
    if (quota?.notifyAtOneHour && (!email || quota.limitMilliseconds === null))
      throw fail('INVALID_QUOTA', '通知を有効にする場合は連絡先メールアドレスと上限を設定してください。');
    if (!domain || !name || name.length > 200 || email.length > 254 || notes.length > 5000
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
      const targetPartner = input.partnerID === undefined ? row.data().partnerID : input.partnerID;
      if (partnerID === null && (lifecycle || input.partnerID !== undefined)) {
        if (typeof targetPartner !== 'string' || (targetPartner !== SELF_PARTNER_ID && !/^[a-f0-9]{64}$/.test(targetPartner)))
          throw fail('INVALID_PARTNER', '販売店を選択してください。');
        const dealer = targetPartner === SELF_PARTNER_ID ? null : await tx.get(this.collection('partners').doc(targetPartner));
        if (targetPartner !== SELF_PARTNER_ID && (targetPartner !== row.data().partnerID || lifecycle?.status === 'approved') && (!dealer.exists || dealer.data().status !== 'active'))
          throw fail('FORBIDDEN', '販売店が無効です。');
      }
      const nextStatus = lifecycle ? (lifecycle.hasValidityPeriod && this.now() >= lifecycle.validityEndsAt ? 'suspended' : lifecycle.status) : row.data().status;
      const portal = this.portal && partnerID === null
        ? await this.portal.provision(tx, { ...row.data(), contactEmail: email, status: nextStatus }) : {};
      // 過去の利用台帳・集計と承認日は変更しない。契約設定は同じトランザクションで保存する。
      if (targetPartner !== row.data().partnerID) {
        const previous = row.data();
        // 旧販売店には移管時の表示情報と自店の実績だけを残す。
        tx.set(this.collection('corporateDomainAssignments').doc(`${previous.partnerID}_${domain}`), {
          domain, partnerID: previous.partnerID, organizationName: previous.organizationName,
          resetDay: resetDay(previous), transferredAt: this.now(), status: 'suspended',
        });
      }
      tx.update(ref, { ...portal, organizationName: name, contactEmail: email, notes,
        ...(lifecycle ? { ...lifecycle, status: lifecycle.hasValidityPeriod && this.now() >= lifecycle.validityEndsAt ? 'suspended' : lifecycle.status } : {}),
        ...(partnerID === null && input.partnerID !== undefined ? { partnerID: targetPartner } : {}),
        ...(quota || {}),
        ...(quota && quota.resetDay !== resetDay(row.data())
          ? { quotaRevision: (row.data().quotaRevision || 0) + 1 } : {}) });
    });
    if (this.portal && partnerID === null) await this.portal.deliverForDomain(domain);
  }
  async domainRows(partnerID) {
    let current = this.collection('corporateDomains'), history = this.collection('corporateDomainAssignments');
    if (partnerID) {
      current = current.where('partnerID', '==', partnerID);
      history = history.where('partnerID', '==', partnerID);
    }
    const [active, previous] = await Promise.all([current.get(), history.get()]);
    const rows = new Map(active.docs.map(doc => [`${doc.data().partnerID}_${doc.id}`, { ...doc.data(), domain: doc.id }]));
    for (const doc of previous.docs) {
      const row = doc.data(), key = `${row.partnerID}_${row.domain}`;
      if (!rows.has(key)) rows.set(key, { ...row, historical: true });
    }
    return [...rows.values()];
  }
  async deleteDomain(domain) {
    if (!domain || normalizeDomain(domain) !== domain) throw fail('INVALID_DOMAIN', 'ドメインを確認してください。');
    await this.provider().runTransaction(async tx => {
      const ref = this.collection('corporateDomains').doc(domain), row = await tx.get(ref);
      if (!row.exists) throw fail('NOT_FOUND', '登録情報はありません。');
      if (row.data().status !== 'suspended') throw fail('DOMAIN_ACTIVE', '先に登録を無効にしてください。');
      const state = await deletionState(this.provider(), domain, query => tx.get(query));
      if (!state.canDelete) throw fail('DOMAIN_IN_USE', '利用実績または未精算の処理があるため削除できません。');
      const history = await tx.get(this.collection('corporateDomainAssignments').where('domain', '==', domain));
      const periods = await tx.get(this.collection('corporateQuotaPeriods'));
      const notifications = await tx.get(this.collection('corporateQuotaNotifications'));
      const docs = [...history.docs, ...state.ledger.docs, ...state.months.docs,
        ...periods.docs.filter(doc => doc.id.startsWith(`${domain}_`)),
        ...notifications.docs.filter(doc => doc.id.startsWith(`${domain}_`))];
      if (docs.length > 400) throw fail('TOO_MANY_RECORDS', '管理者による個別対応が必要です。');
      for (const doc of docs) tx.delete(doc.ref);
      tx.delete(ref);
    });
  }
  async dashboard(partnerID, month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw fail('INVALID_MONTH', '対象月を確認してください。');
    const domainRows = await this.domainRows(partnerID);
    // 閲覧可能なドメインの指定月だけを読む。過去全月・他店・会員情報は読まない。
    return Promise.all(domainRows.map(async data => {
      const id = data.domain;
      if (!data.historical) await refreshDomain(this.provider(), id, this.now());
      const [year, monthNumber] = month.split('-').map(Number);
      const quota = await this.provider().runTransaction(async tx => {
        const current = await tx.get(this.collection('corporateDomains').doc(id));
        const historical = data.historical || !current.exists || current.data().partnerID !== data.partnerID;
        const settings = historical ? { domain: id, partnerID: data.partnerID, organizationName: data.organizationName,
          resetDay: resetDay(data), status: 'suspended', historical: true } : current.data();
        if (historical) return { settings, usage: { realtime: 0, mediaFile: 0, formalTranslation: 0 },
          period: periodAt(month === monthAt(this.now()) ? this.now() : boundary(year, monthNumber - 1, resetDay(settings)), settings) };
        const value = await readQuota(this.provider(), tx, id, settings,
          month === monthAt(this.now()) ? this.now() : boundary(year, monthNumber - 1, resetDay(settings)));
        if (value.missing && !data.historical) saveQuota(tx, value);
        return { ...value, settings };
      });
      const ledger = await this.collection('corporateUsageLedger').where('domain', '==', id)
        .where('occurredAt', '>=', new Date(quota.period.start)).where('occurredAt', '<', new Date(quota.period.end)).get();
      const usage = { realtime: 0, mediaFile: 0, formalTranslation: 0 };
      for (const entry of ledger.docs) {
        const item = entry.data();
        if (item.partnerID === data.partnerID && Object.hasOwn(usage, item.operation)) usage[item.operation] += item.milliseconds;
      }
      const canDelete = !quota.settings.historical && quota.settings.status === 'suspended' && (await deletionState(this.provider(), id)).canDelete;
      return { ...quota.settings, canDelete, historical: !!quota.settings.historical, displayState: displayState(quota.settings, this.now()), resetDay: resetDay(quota.settings), id,
        usage, periodStart: quota.period.start, periodEnd: quota.period.end,
        ...quotaStatus(quota.settings, totalUsage(quota.usage)) };
    }));
  }
  async yearlyUsage(partnerID, year) {
    if (!Number.isInteger(year) || year < 2000 || year > 9999)
      throw fail('INVALID_YEAR', '対象年を確認してください。');
    const rows = await this.domainRows(partnerID);
    return Promise.all(rows.map(async data => {
      const months = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
        const month = `${year}-${String(index + 1).padStart(2, '0')}`;
        const snapshot = await this.collection('corporateUsageMonths').doc(`${data.partnerID}_${data.domain}_${month}`).get();
        const usage = snapshot.exists ? snapshot.data() : {};
        const realtime = usage.realtime || 0, mediaFile = usage.mediaFile || 0, formalTranslation = usage.formalTranslation || 0;
        return { month: index + 1, realtime, mediaFile, formalTranslation, total: realtime + mediaFile + formalTranslation };
      }));
      return { domain: data.domain, organizationName: data.organizationName, partnerID: data.partnerID, historical: !!data.historical, months,
        total: months.reduce((sum, item) => sum + item.total, 0) };
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
