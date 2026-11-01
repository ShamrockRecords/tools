const { getFirestore } = require('../firestore');
const { mojidasCollection } = require('../mojidas_firestore');
const { time } = require('./corporate_billing_policy');
const { safeURL } = require('./corporate_billing_service');

const timestamp = value => {
  const result = time(value);
  return Number.isFinite(result) ? result : null;
};

class MojidasCorporateInvoiceStore {
  constructor({ firestoreProvider = getFirestore, now = Date.now } = {}) {
    this.provider = firestoreProvider;
    this.now = now;
  }

  async listIssued() {
    // 管理者一覧は全期間・全法人を読む。契約の現状やStripeを参照して書き換えない。
    const snapshot = await mojidasCollection(this.provider(), 'corporateInvoices').get();
    const at = this.now();
    return snapshot.docs.map(doc => {
      const row = doc.data(), issuedAt = timestamp(row.issuedAt);
      if (issuedAt === null) return null;
      const dueAt = timestamp(row.dueAt);
      return {
        id: doc.id, month: row.month || '', organizationName: row.organizationName || '',
        domain: row.domain || '', email: row.email || '', plan: row.plan || row.terms?.plan || '',
        number: row.number || '', totalJPY: Number.isSafeInteger(row.totalJPY) ? row.totalJPY : null,
        issuedAt, dueAt, paidAt: timestamp(row.paidAt), pdfURL: safeURL(row.pdfURL, true),
        state: row.state === 'open' && dueAt !== null && at >= dueAt + 1000 ? 'overdue' : row.state,
      };
    }).filter(Boolean).sort((a, b) => b.issuedAt - a.issuedAt
      || b.month.localeCompare(a.month) || a.domain.localeCompare(b.domain) || a.id.localeCompare(b.id));
  }
}

module.exports = new MojidasCorporateInvoiceStore();
module.exports.MojidasCorporateInvoiceStore = MojidasCorporateInvoiceStore;
