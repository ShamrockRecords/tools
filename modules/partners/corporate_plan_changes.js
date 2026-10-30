const { mojidasCollection } = require('../mojidas_firestore');
const { PLANS, HOUR, period, monthAt, contractID, hash } = require('../billing/corporate_billing_policy');
const { prepareContractChange } = require('../billing/corporate_billing_contracts');
const { normalizeDomain } = require('./domain_policy');

const fail = code => { throw Object.assign(new Error(code), { code }); };
const nextMonth = now => monthAt(period(monthAt(now)).end);
// 連絡先・組織名の修正では予約を失わず、契約条件の変更とは区別する。
const source = row => hash(JSON.stringify([contractID(row), row.partnerID, row.portalAccountID,
  row.plan, row.status, row.hasValidityPeriod === true, row.validityStartsAt ?? null,
  row.validityEndsAt ?? null, row.limitMilliseconds ?? null]));
function invalidatePlanReservation(before, after) {
  const relevant = row => row.partnerID === 'self' && Object.hasOwn(PLANS, row.plan);
  return (before.pendingPlanChange || relevant(before) || relevant(after)) && source(before) !== source(after)
    ? { pendingPlanChange: null, planChangeVersion: (before.planChangeVersion || 0) + 1 } : {};
}
function eligible(row, now) {
  const start = period(nextMonth(now)).start;
  return row.partnerID === 'self' && row.status === 'approved' && Object.hasOwn(PLANS, row.plan)
    && row.limitMilliseconds === PLANS[row.plan].hours * HOUR
    && (row.hasValidityPeriod !== true || (row.validityStartsAt <= now && start < row.validityEndsAt));
}
const due = (row, now) => row?.pendingPlanChange && row.pendingPlanChange.effectiveAt <= now;
function duePlanPatch(row, now) {
  if (!due(row, now)) return null;
  const pending = row.pendingPlanChange;
  if (pending.source !== source(row) || !Object.hasOwn(PLANS, pending.plan)) return { pendingPlanChange: null };
  return { plan: pending.plan, limitMilliseconds: PLANS[pending.plan].hours * HOUR,
    resetDay: 1, quotaRevision: (row.quotaRevision || 0) + 1, pendingPlanChange: null,
    planChangedAt: pending.effectiveAt, planChangedBy: pending.updatedBy };
}

// 予約適用と請求履歴を原子的に保存する。遅延実行でも有効時刻は翌月1日0時。
async function applyDuePlan(db, domain, now) {
  const ref = mojidasCollection(db, 'corporateDomains').doc(domain);
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref), row = snapshot.data();
    if (!due(row, now)) return;
    const pending = row.pendingPlanChange, patch = duePlanPatch({ ...row, domain }, now);
    if (!patch.plan) {
      tx.update(ref, patch);
      return;
    }
    const write = await prepareContractChange(db, tx, { ...row, domain }, pending.effectiveAt);
    tx.update(ref, patch);
    write({ ...row, ...patch, domain });
  });
}

class DuePlan extends Error { constructor(domain) { super('PLAN_APPLICATION_REQUIRED'); this.domain = domain; } }
async function readCurrentDomain(tx, ref, now) {
  const snapshot = await tx.get(ref);
  if (due(snapshot.data(), now)) throw new DuePlan(ref.id);
  return snapshot;
}
// 月替わりをtransaction内で判定し、予約適用後に全readから再試行する。
// これによりスケジューラーより先に届く利用報告にも新プランを適用する。
async function runPlanTransaction(db, now, work) {
  for (let attempt = 0; ; attempt++) {
    try { return await db.runTransaction(tx => work(tx, now())); }
    catch (error) {
      if (!(error instanceof DuePlan) || attempt >= 3) throw error;
      await applyDuePlan(db, error.domain, now());
    }
  }
}

async function schedulePlan(db, now, login, input) {
  if (!login?.id || login.mustChangePassword || typeof input.domain !== 'string'
    || normalizeDomain(input.domain) !== input.domain) fail('PLAN_FORBIDDEN');
  if (typeof input.plan !== 'string' || !Object.hasOwn(PLANS, input.plan)) fail('PLAN_INVALID');
  return runPlanTransaction(db, now, async (tx, at) => {
    const ref = mojidasCollection(db, 'corporateDomains').doc(input.domain);
    // 所有権確認前には他社の予約を適用しない。
    const snapshot = await tx.get(ref), row = snapshot.data();
    if (!row || row.portalAccountID !== login.id) fail('PLAN_FORBIDDEN');
    if (input.month !== nextMonth(at)) fail('PLAN_MONTH_CHANGED');
    if (input.contract !== contractID({ ...row, domain: ref.id })) fail('PLAN_CONFLICT');
    if (due(row, at)) throw new DuePlan(ref.id);
    if (!eligible(row, at)) fail('PLAN_UNAVAILABLE');
    if (String(row.planChangeVersion || 0) !== input.version) fail('PLAN_CONFLICT');
    const record = await prepareContractChange(db, tx, { ...row, domain: ref.id }, at);
    const pending = input.plan === row.plan ? null : {
      plan: input.plan, month: input.month, effectiveAt: period(input.month).start,
      source: source({ ...row, domain: ref.id }), updatedAt: at, updatedBy: login.id,
    };
    tx.update(ref, { pendingPlanChange: pending, planChangeVersion: (row.planChangeVersion || 0) + 1 });
    record({ ...row, domain: ref.id });
  });
}

function planView(row, now) {
  const pending = row.pendingPlanChange;
  const valid = pending && pending.source === source(row) && pending.month === nextMonth(now);
  return { currentMonth: monthAt(now), nextMonth: nextMonth(now), canChange: eligible(row, now), contract: contractID(row),
    nextPlan: valid ? pending.plan : row.plan, reserved: !!valid, version: String(row.planChangeVersion || 0),
    standardPricing: row.partnerID === 'self' && Object.hasOwn(PLANS, row.plan)
      && row.limitMilliseconds === PLANS[row.plan].hours * HOUR,
    limitMilliseconds: row.limitMilliseconds ?? null, stopAtLimit: row.stopAtLimit === true };
}

module.exports = { nextMonth, eligible, due, source, invalidatePlanReservation, duePlanPatch, applyDuePlan, readCurrentDomain, runPlanTransaction, schedulePlan, planView };
