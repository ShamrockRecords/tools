const { mojidasCollection } = require('../mojidas_firestore');
const { contractID, terms, time, fail, calculate } = require('./corporate_billing_policy');

// 全readを終えてからwriterを呼び、契約設定と請求履歴を同時に保存する。
async function prepareContractChange(db, tx, before, at, { fromCreation = false } = {}) {
  const id = contractID(before), ref = mojidasCollection(db, 'corporateBillingContracts').doc(id);
  const snapshot = await tx.get(ref);
  const existing = snapshot.exists ? snapshot.data() : {
    id, domain: before.domain, createdAt: time(before.createdAt), knownFrom: at, fromCreation, events: [],
  };
  return after => {
    const value = terms(after), previous = existing.events.at(-1);
    if (previous && JSON.stringify(previous.terms) === JSON.stringify(value)) return;
    if (previous && at < previous.at) fail('BILLING_CLOCK_REVERSED');
    const events = [...existing.events, { at, terms: value }];
    if (events.length > 1000) fail('BILLING_HISTORY_REVIEW_REQUIRED');
    tx.set(ref, { ...existing, events });
  };
}

async function readBilling(db, read, row, month, usage = {}) {
  if (row.partnerID !== 'self' || !['metered', 'light', 'standard'].includes(row.plan) || !row.domain) return null;
  const id = contractID(row), doc = await read(mojidasCollection(db, 'corporateBillingContracts').doc(id));
  if (!doc.exists) return null;
  try { return calculate({ ...doc.data(), id }, month, usage); }
  catch (error) {
    if (['BILLING_HISTORY_REQUIRED', 'CONTRACT_CHANGE_REVIEW_REQUIRED', 'CUSTOM_ALLOWANCE_REVIEW_REQUIRED',
      'BILLING_CONTACT_REQUIRED', 'CUSTOM_CONTRACT_REVIEW_REQUIRED'].includes(error.code)) return null;
    throw error;
  }
}

module.exports = { prepareContractChange, readBilling };
