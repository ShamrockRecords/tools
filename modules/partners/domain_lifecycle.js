const { mojidasCollection } = require('../mojidas_firestore');
const SELF_PARTNER_ID = 'self';
const PLANS = { trial: 'トライアル', metered: '従量制', light: 'ライト', standard: 'スタンダード', custom: 'カスタム' };
const invalid = () => { throw Object.assign(new Error('プラン・有効期間・有効／無効の設定を確認してください。'), { code: 'INVALID_DOMAIN_SETTINGS' }); };

// datetime-localの入力は、ブラウザーのタイムゾーンによらず日本時間として扱う。
function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return NaN;
  const time = Date.parse(`${value}:00+09:00`);
  return Number.isFinite(time) && new Date(time + 9 * 3600000).toISOString().slice(0, 16) === value ? time : NaN;
}
function parseLifecycle(input) {
  const plan = input.plan === undefined ? 'custom' : input.plan;
  const period = input.validityPeriod === undefined ? 'none' : input.validityPeriod;
  const state = input.status === undefined ? 'active' : input.status;
  if (!Object.hasOwn(PLANS, plan) || !['none', 'limited'].includes(period) || !['active', 'inactive'].includes(state)) invalid();
  const validityStartsAt = period === 'limited' ? parseDate(input.validityStartsAt) : null;
  const validityEndsAt = period === 'limited' ? parseDate(input.validityEndsAt) : null;
  if (period === 'limited' && (!Number.isFinite(validityStartsAt) || !Number.isFinite(validityEndsAt) || validityEndsAt <= validityStartsAt)) invalid();
  return { plan, hasValidityPeriod: period === 'limited', validityStartsAt, validityEndsAt, status: state === 'active' ? 'approved' : 'suspended' };
}
function inPeriod(row, now) {
  return row.hasValidityPeriod !== true || (Number.isFinite(row.validityStartsAt) && Number.isFinite(row.validityEndsAt)
    && now >= row.validityStartsAt && now < row.validityEndsAt);
}
function displayState(row, now) {
  if (row.status !== 'approved') return 'inactive';
  if (row.hasValidityPeriod === true && now < row.validityStartsAt) return 'scheduled';
  return inPeriod(row, now) ? 'active' : 'inactive';
}
function lifecyclePatch(row, now) {
  const patch = {};
  if (row.plan === undefined) patch.plan = 'custom';
  if (row.hasValidityPeriod === undefined) Object.assign(patch, { hasValidityPeriod: false, validityStartsAt: null, validityEndsAt: null });
  if (row.hasValidityPeriod === true && row.status === 'approved' && now >= row.validityEndsAt) Object.assign(patch, { status: 'suspended', expiredAt: now });
  return patch;
}
async function refreshDomain(db, domain, now) {
  const ref = mojidasCollection(db, 'corporateDomains').doc(domain);
  const snapshot = await ref.get();
  if (!snapshot.exists) return null;
  const initial = snapshot.data();
  if (!Object.keys(lifecyclePatch(initial, now)).length) return initial;
  return db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (!current.exists) return null;
    const row = current.data(), patch = lifecyclePatch(row, now);
    if (Object.keys(patch).length) tx.update(ref, patch);
    return { ...row, ...patch };
  });
}
module.exports = { SELF_PARTNER_ID, PLANS, parseDate, parseLifecycle, inPeriod, displayState, lifecyclePatch, refreshDomain };
