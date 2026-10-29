const { getFirestore } = require('../firestore');
const { mojidasCollection, mojidasRootPath } = require('../mojidas_firestore');
const { prepareContractChange } = require('./corporate_billing_contracts');
const { hash, fail, monthAt, period, monthsUntil, contractID, calculate } = require('./corporate_billing_policy');

const INVOICE_EVENTS = new Set(['invoice.finalized', 'invoice.paid', 'invoice.payment_succeeded',
  'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided',
  'invoice.marked_uncollectible', 'invoice.updated', 'invoice.sent']);
const invoiceID = (id, month) => `${id}_${month}`;
const safeURL = (value, pdf = false) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && !url.port && (pdf ? ['pay.stripe.com', 'invoice.stripe.com'].includes(url.hostname)
        : url.hostname === 'invoice.stripe.com') ? url.href : null;
  } catch (_) { return null; }
};

class CorporateBillingService {
  constructor({ firestoreProvider = getFirestore, stripeClient, now = Date.now, environment = process.env } = {}) {
    this.provider = firestoreProvider; this.client = stripeClient; this.now = now; this.environment = environment;
  }
  collection(name) { return mojidasCollection(this.provider(), name); }
  get stripe() {
    if (this.client) return this.client;
    if (!this.environment.STRIPE_SECRET_KEY) fail('STRIPE_NOT_CONFIGURED');
    const Stripe = require('stripe');
    this.client = new Stripe(this.environment.STRIPE_SECRET_KEY, { timeout: 20000, maxNetworkRetries: 1 });
    return this.client;
  }
  async observeContracts() {
    const domains = await this.collection('corporateDomains').get();
    for (const doc of domains.docs) {
      await this.provider().runTransaction(async tx => {
        const current = await tx.get(doc.ref);
        if (!current.exists) return;
        const row = { ...current.data(), domain: doc.id };
        const write = await prepareContractChange(this.provider(), tx, row, this.now());
        write(row);
      });
    }
  }
  // 導入前の契約履歴は推測しない。運用者が最初の記録の条件を遡って確認した場合だけ補完。
  async confirmHistory(domain, from, execute) {
    if (require('../partners/domain_policy').normalizeDomain(domain) !== domain) fail('INVALID_DOMAIN');
    const at = Date.parse(`${from}T00:00:00+09:00`);
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(at)
      || new Date(at + 9 * 3600000).toISOString().slice(0, 10) !== from || at > this.now()) fail('INVALID_HISTORY_DATE');
    return this.provider().runTransaction(async tx => {
      const domainDoc = await tx.get(this.collection('corporateDomains').doc(domain));
      if (!domainDoc.exists) fail('BILLING_CONTRACT_NOT_FOUND');
      const row = { ...domainDoc.data(), domain }, id = contractID(row);
      const ref = this.collection('corporateBillingContracts').doc(id), doc = await tx.get(ref);
      const invoices = await tx.get(this.collection('corporateInvoices').where('contractID', '==', id));
      if (!doc.exists || !doc.data().events.length) fail('RECORD_CONTRACT_FIRST');
      const contract = doc.data();
      if (invoices.docs.length) fail('BILLING_ALREADY_SNAPSHOTTED');
      const fromAt = Math.max(at, contract.createdAt ?? at);
      if (fromAt >= contract.knownFrom) fail('HISTORY_ALREADY_KNOWN');
      const first = contract.events[0];
      const confirmed = { ...contract, knownFrom: fromAt, fromCreation: fromAt === contract.createdAt,
        historyConfirmedAt: this.now(), events: [{ at: fromAt, terms: first.terms }, ...contract.events] };
      if (execute) tx.set(ref, confirmed);
      return { domain, from, terms: first.terms, executed: execute };
    });
  }
  async snapshot(id, month, execute) {
    const p = period(month);
    if (p.end > this.now()) fail('BILLING_MONTH_NOT_CLOSED');
    return this.provider().runTransaction(async tx => {
      const ref = this.collection('corporateInvoices').doc(invoiceID(id, month));
      const previous = await tx.get(ref);
      if (previous.exists) return { id: ref.id, ...previous.data() };
      const contract = await tx.get(this.collection('corporateBillingContracts').doc(id));
      if (!contract.exists) fail('BILLING_CONTRACT_NOT_FOUND');
      const statsRef = this.collection('corporateUsageMonths').doc(`self_${contract.data().domain}_${month}`);
      const stats = await tx.get(statsRef), source = stats.exists ? stats.data() : {};
      const basis = { ...contract.data(), id };
      const window = calculate(basis, month, {});
      if (!window) return null;
      let usage = source;
      if (window.billingStart > p.start) {
        // 開始・再開前の無料トライアル等を有料利用に混ぜない。
        const ledger = await tx.get(this.collection('corporateUsageLedger').where('domain', '==', window.domain)
          .where('occurredAt', '>=', new Date(window.billingStart)).where('occurredAt', '<', new Date(p.end)));
        usage = { realtime: 0, mediaFile: 0, formalTranslation: 0 };
        for (const entry of ledger.docs) {
          const item = entry.data();
          if (item.partnerID === 'self' && Object.hasOwn(usage, item.operation)) usage[item.operation] += item.milliseconds;
        }
      }
      const result = calculate(basis, month, usage);
      if (!result) return null;
      const domainDoc = await tx.get(this.collection('corporateDomains').doc(result.domain));
      const current = domainDoc.exists ? { ...domainDoc.data(), domain: result.domain } : null;
      // 料金は対象月の履歴、送付先は確定時の同じ直販契約から固定する。
      const contact = current && current.partnerID === 'self' && contractID(current) === id ? current : result.terms;
      if (!contact.portalAccountID || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.contactEmail)) fail('BILLING_CONTACT_REQUIRED');
      Object.assign(result, { organizationName: contact.organizationName, email: contact.contactEmail,
        portalAccountID: contact.portalAccountID });
      const data = { ...result, state: 'pending', createdAt: this.now(), stripeInvoiceID: null,
        sourceDigest: hash(JSON.stringify(result.usage)), lastError: null };
      if (execute) {
        tx.set(ref, data);
        // 利用確定transactionと競合させ、締め前に開始した遅い書き込みも再試行させる。
        tx.set(statsRef, { ...source, domain: result.domain, partnerID: 'self', month,
          billingClosedAt: this.now(), billingSnapshotID: ref.id });
      }
      return { id: ref.id, ...data };
    });
  }
  async save(id, patch) { await this.collection('corporateInvoices').doc(id).update(patch); }

  async findResult(list, query, matches) {
    let cursor, found = null;
    for (let page = 0; page < 10; page++) {
      const result = await list({ ...query, limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
      for (const item of result.data) if (matches(item)) {
        if (found) fail('STRIPE_RESULT_REVIEW_REQUIRED');
        found = item;
      }
      if (!result.has_more) return found;
      cursor = result.data.at(-1)?.id;
      if (!cursor) break;
    }
    fail('STRIPE_RESULT_REVIEW_REQUIRED');
  }

  // Firestoreの永続記録とStripeの冪等キーを併用。24時間を越えた結果不明のPOSTは自動再発行しない。
  async operation(name, params, send, recover) {
    const key = hash(`${mojidasRootPath()}:corporate-v1:${name}`), digest = hash(JSON.stringify(params));
    const ref = this.collection('corporateBillingOperations').doc(key);
    const state = await this.provider().runTransaction(async tx => {
      const previous = await tx.get(ref);
      if (previous.exists) {
        if (previous.data().digest !== digest) fail('BILLING_OPERATION_CONFLICT');
        return previous.data();
      }
      const data = { name, digest, params, startedAt: this.now(), result: null };
      tx.set(ref, data); return data;
    });
    if (state.result) return state.result;
    let result;
    if (this.now() - state.startedAt >= 23 * 3600000) {
      result = recover ? await recover({ startedAt: state.startedAt, idempotencyKey: `mojidas-corporate-${key}` }) : null;
      if (!result) fail('STRIPE_RESULT_REVIEW_REQUIRED');
    } else result = await send({ idempotencyKey: `mojidas-corporate-${key}` });
    if (!result?.id) fail('INVALID_STRIPE_RESPONSE');
    const saved = { id: result.id };
    await ref.update({ result: saved, completedAt: this.now() });
    return saved;
  }
  async claim(id) {
    const token = require('crypto').randomUUID();
    const ref = this.collection('corporateInvoices').doc(id);
    return this.provider().runTransaction(async tx => {
      const snapshot = await tx.get(ref), data = snapshot.data();
      if (!data || data.leaseUntil > this.now()) return null;
      tx.update(ref, { leaseToken: token, leaseUntil: this.now() + 5 * 60000 }); return token;
    });
  }
  async release(id, token) {
    const ref = this.collection('corporateInvoices').doc(id);
    await this.provider().runTransaction(async tx => {
      const current = await tx.get(ref);
      if (current.data()?.leaseToken === token) tx.update(ref, { leaseUntil: 0 });
    });
  }
  async issue(id) {
    const token = await this.claim(id);
    if (!token) return;
    try {
      let row = (await this.collection('corporateInvoices').doc(id).get()).data();
      if (row.stripeInvoiceID) {
        const current = await this.stripe.invoices.retrieve(row.stripeInvoiceID);
        if (current.status !== 'draft') {
          await this.syncInvoice(current, id);
          if (!row.sentAt && current.status === 'open') await this.sendInvoice(id, current.id, 'initial');
          await this.save(id, { lastError: null });
          return;
        }
      }
      if (!row.issueMonth) {
        await this.save(id, { issueMonth: monthAt(this.now()), dueAt: period(monthAt(this.now())).end - 1000,
          taxRateID: this.environment.MOJIDAS_CORPORATE_TAX_RATE_ID || null });
        row = (await this.collection('corporateInvoices').doc(id).get()).data();
      }
      if (row.issueMonth !== monthAt(this.now())) fail('BILLING_ISSUE_MONTH_REVIEW_REQUIRED');
      const customerParams = { name: row.organizationName, email: row.email, preferred_locales: ['ja'],
        metadata: { mojidasCorporateContractID: row.contractID, mojidasEnvironment: mojidasRootPath() } };
      // 連絡先変更時は別Customerとし、並行する過去月の宛先を変更しない。
      const customerKey = hash(JSON.stringify(customerParams));
      const customer = await this.operation(`customer:${customerKey}`, customerParams,
        opts => this.stripe.customers.create(customerParams, opts),
        () => this.findResult(p => this.stripe.customers.list(p), { email: row.email },
          c => c.name === customerParams.name && c.email === row.email
            && c.metadata?.mojidasCorporateContractID === row.contractID && c.metadata?.mojidasEnvironment === mojidasRootPath()));
      const params = { customer: customer.id, currency: 'jpy', collection_method: 'send_invoice',
        auto_advance: false, automatic_tax: { enabled: false },
        due_date: Math.floor(row.dueAt / 1000), pending_invoice_items_behavior: 'exclude',
        payment_settings: { payment_method_types: ['card'] }, discounts: [],
        description: `Mojidas ${row.month}利用分（${row.domain}）・金額は税込`,
        custom_fields: [{ name: 'ご利用月（日本時間）', value: row.month }, { name: '対象ドメイン', value: row.domain.slice(0, 140) }],
        metadata: { mojidasCorporateInvoiceID: id, mojidasEnvironment: mojidasRootPath() } };
      const invoice = await this.operation(`invoice:${id}`, params, opts => this.stripe.invoices.create(params, opts),
        () => this.findResult(p => this.stripe.invoices.list(p), { customer: customer.id },
          i => i.metadata?.mojidasCorporateInvoiceID === id && i.metadata?.mojidasEnvironment === mojidasRootPath()));
      if (row.stripeInvoiceID && row.stripeInvoiceID !== invoice.id) fail('STRIPE_INVOICE_MISMATCH');
      await this.save(id, { stripeInvoiceID: invoice.id, stripeCustomerID: customer.id });
      // 税込総額を変えない。適格請求書向けの税率IDを設定する場合は内税10%に限定する。
      const taxID = row.taxRateID;
      if (taxID) {
        const tax = await this.stripe.taxRates.retrieve(taxID);
        if (!tax.active || !tax.inclusive || tax.percentage !== 10) fail('INVALID_CORPORATE_TAX_RATE');
      }
      for (const line of row.lines) {
        const item = { customer: customer.id, invoice: invoice.id, currency: 'jpy', amount: line.amount,
          description: line.label, discountable: false, tax_rates: taxID ? [taxID] : [],
          period: { start: Math.floor(row.periodStart / 1000), end: Math.floor(row.periodEnd / 1000) },
          metadata: { mojidasCorporateLine: `${id}:${line.key}` } };
        await this.operation(`line:${id}:${line.key}`, item, opts => this.stripe.invoiceItems.create(item, opts),
          () => this.findResult(p => this.stripe.invoiceItems.list(p), { invoice: invoice.id, customer: customer.id },
            i => i.metadata?.mojidasCorporateLine === item.metadata.mojidasCorporateLine
              && i.amount === item.amount && i.currency === item.currency && i.description === item.description));
      }
      const draft = await this.stripe.invoices.retrieve(invoice.id);
      this.validateInvoice(draft, { ...row, stripeInvoiceID: invoice.id, stripeCustomerID: customer.id }, id);
      if (draft.status === 'draft') {
        await this.operation(`finalize:${id}`, { invoice: invoice.id },
          opts => this.stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false }, opts),
          async () => { const latest = await this.stripe.invoices.retrieve(invoice.id); return latest.status !== 'draft' ? latest : null; });
      }
      const finalized = await this.stripe.invoices.retrieve(invoice.id);
      await this.syncInvoice(finalized, id);
      if (finalized.status === 'open') await this.sendInvoice(id, invoice.id, 'initial');
      await this.save(id, { lastError: null });
    } catch (error) {
      await this.save(id, { lastError: error.code || 'BILLING_PROCESSING_FAILED' });
      throw error;
    } finally { await this.release(id, token); }
  }
  validateInvoice(invoice, row, id) {
    const customer = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    if (invoice.id !== row.stripeInvoiceID || customer !== row.stripeCustomerID
      || invoice.metadata?.mojidasCorporateInvoiceID !== id || invoice.metadata?.mojidasEnvironment !== mojidasRootPath()
      || invoice.currency !== 'jpy' || invoice.total !== row.totalJPY
      || invoice.collection_method !== 'send_invoice' || invoice.due_date !== Math.floor(row.dueAt / 1000)
      || invoice.lines?.has_more || invoice.lines?.data?.length !== row.lines.length
      || row.lines.some(line => !invoice.lines.data.some(item => item.amount === line.amount
        && item.metadata?.mojidasCorporateLine === `${id}:${line.key}`))) fail('STRIPE_INVOICE_MISMATCH');
  }
  async syncInvoice(invoice, id) {
    const ref = this.collection('corporateInvoices').doc(id);
    await this.provider().runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) fail('BILLING_INVOICE_NOT_FOUND');
      const row = snapshot.data(); this.validateInvoice(invoice, row, id);
      if (!['draft', 'open', 'paid', 'void', 'uncollectible'].includes(invoice.status)) fail('INVALID_STRIPE_RESPONSE');
      // 遅れた通知で支払済み・取消を未払いへ戻さない。
      if ((row.state === 'paid' && invoice.status !== 'paid') || (row.state === 'void' && invoice.status !== 'void')) return;
      tx.update(ref, { state: invoice.status, number: invoice.number || null,
        issuedAt: invoice.status_transitions?.finalized_at ? invoice.status_transitions.finalized_at * 1000 : null,
        paidAt: invoice.status_transitions?.paid_at ? invoice.status_transitions.paid_at * 1000 : null,
        paidOutOfBand: invoice.paid_out_of_band === true,
        hostedURL: safeURL(invoice.hosted_invoice_url), pdfURL: safeURL(invoice.invoice_pdf, true),
        stripeSyncedAt: this.now() });
    });
  }
  async sendInvoice(id, remoteID, kind) {
    const latest = await this.stripe.invoices.retrieve(remoteID);
    await this.syncInvoice(latest, id);
    if (latest.status !== 'open') return;
    await this.operation(`mail:${id}:${kind}`, { invoice: remoteID },
      opts => this.stripe.invoices.sendInvoice(remoteID, {}, opts),
      context => this.findResult(p => this.stripe.events.list(p), {
        type: 'invoice.sent', created: { gte: Math.floor(context.startedAt / 1000) },
      }, e => e.data?.object?.id === remoteID && e.request?.idempotency_key === context.idempotencyKey));
    await this.save(id, kind === 'initial' ? { sentAt: this.now() } : { reminderSentAt: this.now() });
  }
  async processWebhookEvent(event) {
    if (!INVOICE_EVENTS.has(event?.type)) return { handled: false };
    const object = event.data?.object, id = object?.metadata?.mojidasCorporateInvoiceID;
    if (!id || object.metadata.mojidasEnvironment !== mojidasRootPath()) return { handled: false };
    if (!/^[a-f0-9]{64}_20\d{2}-(0[1-9]|1[0-2])$/.test(id) || typeof object.id !== 'string') fail('INVALID_CORPORATE_WEBHOOK');
    const latest = await this.stripe.invoices.retrieve(object.id);
    await this.syncInvoice(latest, id);
    return { handled: true, corporate: true };
  }
  async history(user) {
    if (!user?.id || user.mustChangePassword) fail('FORBIDDEN');
    const docs = await this.collection('corporateInvoices').where('portalAccountID', '==', user.id).get();
    return docs.docs.map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(row => row.issuedAt).sort((a, b) => b.month.localeCompare(a.month) || a.domain.localeCompare(b.domain))
      .map(row => ({ id: row.id, month: row.month, domain: row.domain, organizationName: row.organizationName,
        number: row.number, totalJPY: row.totalJPY, lines: row.lines, usedMilliseconds: row.usedMilliseconds,
        includedMilliseconds: row.includedMilliseconds, billableMinutes: row.billableMinutes,
        days: row.days, monthDays: row.monthDays, issuedAt: row.issuedAt, dueAt: row.dueAt,
        paidAt: row.paidAt, state: row.state === 'open' && this.now() >= row.dueAt + 1000 ? 'overdue' : row.state }));
  }
  async link(user, id, kind) {
    if (!user?.id || user.mustChangePassword || !/^[a-f0-9]{64}_20\d{2}-\d{2}$/.test(id)) fail('FORBIDDEN');
    const snapshot = await this.collection('corporateInvoices').doc(id).get();
    if (!snapshot.exists || snapshot.data().portalAccountID !== user.id || !snapshot.data().issuedAt) fail('FORBIDDEN');
    const latest = await this.stripe.invoices.retrieve(snapshot.data().stripeInvoiceID);
    await this.syncInvoice(latest, id);
    const url = kind === 'pdf' ? safeURL(latest.invoice_pdf, true) : safeURL(latest.hosted_invoice_url);
    if (!url) fail('INVOICE_LINK_UNAVAILABLE');
    return url;
  }
  async run({ execute = false, firstMonth = this.environment.MOJIDAS_CORPORATE_BILLING_FIRST_MONTH || '2026-10' } = {}) {
    const months = monthsUntil(firstMonth, this.now()), result = { execute, firstMonth, invoices: [], errors: [] };
    if (execute) await this.observeContracts();
    const contracts = await this.collection('corporateBillingContracts').get();
    const knownDomains = new Set(contracts.docs.map(doc => doc.data().domain));
    const domains = await this.collection('corporateDomains').get();
    for (const doc of domains.docs) {
      if (!knownDomains.has(doc.id) && doc.data().partnerID === 'self' && doc.data().plan !== 'trial')
        result.errors.push({ domain: doc.id, code: 'BILLING_HISTORY_REQUIRED' });
    }
    for (const contract of contracts.docs) for (const month of months) {
      if (contract.data().createdAt && contract.data().createdAt >= period(month).end) continue;
      try {
        const row = await this.snapshot(contract.id, month, execute);
        if (!row) continue;
        result.invoices.push({ id: row.id, month, domain: row.domain, totalJPY: row.totalJPY });
        if (execute && (!row.issuedAt || (row.state === 'open' && !row.sentAt))) await this.issue(row.id);
      } catch (error) { result.errors.push({ contractID: contract.id, month, code: error.code || 'BILLING_FAILED' }); }
    }
    if (execute) {
      const invoices = await this.collection('corporateInvoices').get();
      for (const doc of invoices.docs) {
        const row = doc.data();
        if (!row.stripeInvoiceID || row.state !== 'open') continue;
        try {
          const latest = await this.stripe.invoices.retrieve(row.stripeInvoiceID);
          await this.syncInvoice(latest, doc.id);
          if (latest.status === 'open' && row.sentAt && !row.reminderSentAt && this.now() >= row.dueAt + 1000)
            await this.sendInvoice(doc.id, row.stripeInvoiceID, 'overdue-once');
        } catch (error) { result.errors.push({ invoiceID: doc.id, code: error.code || 'BILLING_SYNC_FAILED' }); }
      }
    }
    return result;
  }
}
module.exports = { CorporateBillingService, INVOICE_EVENTS, safeURL };
