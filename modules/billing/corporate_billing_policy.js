const crypto = require('crypto');

const DAY = 86400000, JST = 9 * 3600000, HOUR = 3600000;
const PLANS = Object.freeze({
  metered: { label: '従量制', base: 2200, fee: 0, hours: 0 },
  light: { label: 'ライト', base: 2200, fee: 11000, hours: 50 },
  standard: { label: 'スタンダード', base: 2200, fee: 22000, hours: 100 },
});
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const time = value => value?.toMillis ? value.toMillis() : value?.toDate ? value.toDate().getTime()
  : typeof value === 'number' ? value : value == null ? null : new Date(value).getTime();
const monthAt = value => new Date(value + JST).toISOString().slice(0, 7);
function period(month) {
  if (typeof month !== 'string' || !/^(20\d{2})-(0[1-9]|1[0-2])$/.test(month)) fail('INVALID_BILLING_MONTH');
  const [y, m] = month.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1) - JST, end = Date.UTC(y, m, 1) - JST;
  return { start, end, days: (end - start) / DAY };
}
function monthsUntil(first, now) {
  period(first);
  const months = [];
  for (let month = first; month < monthAt(now); month = monthAt(period(month).end)) months.push(month);
  return months;
}
function contractID(row) { return hash(`${row.domain}:${time(row.createdAt) ?? 'legacy'}`); }
function terms(row) {
  return {
    domain: row.domain, partnerID: row.partnerID || null, plan: row.plan || 'custom',
    status: row.status || 'suspended', organizationName: row.organizationName || '',
    contactEmail: row.contactEmail || '', portalAccountID: row.portalAccountID || null,
    hasValidityPeriod: row.hasValidityPeriod === true,
    validityStartsAt: time(row.validityStartsAt), validityEndsAt: time(row.validityEndsAt),
    limitMilliseconds: row.limitMilliseconds ?? null,
    pricingVersion: '2026-10-v1',
  };
}

// 途中の四捨五入を避け、有理数を整数演算して最後に1円未満を切り捨てる。
function price(plan, days, monthDays, usedMilliseconds) {
  const p = PLANS[plan];
  if (!p || !Number.isSafeInteger(usedMilliseconds) || usedMilliseconds < 0
    || !Number.isInteger(monthDays) || monthDays < 28 || monthDays > 31
    || !Number.isInteger(days) || days < 1 || days > monthDays) fail('INVALID_BILLING_INPUT');
  const denominator = BigInt(monthDays), included = BigInt(p.hours * HOUR) * BigInt(days);
  const excess = BigInt(usedMilliseconds) * denominator - included;
  const minuteDenominator = 60000n * denominator;
  const minutes = excess > 0n ? (excess + minuteDenominator - 1n) / minuteDenominator : 0n;
  const numerator = BigInt(p.base + p.fee) * BigInt(days) * 2n + minutes * 11n * denominator;
  const total = numerator / (2n * denominator);
  if (total > 99999999n) fail('BILLING_AMOUNT_REVIEW_REQUIRED');
  const base = Math.floor(p.base * days / monthDays), fee = Math.floor(p.fee * days / monthDays);
  const usage = Number(minutes * 11n / 2n);
  const lines = [
    { key: 'base', label: `基本料金（${days}/${monthDays}日）`, amount: base },
    { key: 'plan', label: `${p.label}プラン料金（${days}/${monthDays}日）`, amount: fee },
    { key: 'usage', label: `${plan === 'metered' ? '従量' : '超過'}料金 ${minutes}分 × 5.5円`, amount: usage },
    { key: 'rounding', label: '合計時の円未満端数調整', amount: Number(total) - base - fee - usage },
  ].filter(line => line.amount !== 0);
  return { plan, planLabel: p.label, days, monthDays, usedMilliseconds,
    includedMilliseconds: Number(included) / monthDays, billableMinutes: Number(minutes),
    totalJPY: Number(total), lines, rounding: 'monthly-minutes-ceil-total-yen-floor-v1' };
}

function calculate(contract, month, usage) {
  const p = period(month);
  if (!contract?.events?.length) fail('BILLING_HISTORY_REQUIRED');
  if (!contract.events.some(e => e.terms.partnerID === 'self' && e.terms.plan !== 'trial')) return null;
  if (contract.knownFrom > p.start && !(contract.fromCreation && contract.createdAt >= p.start))
    fail('BILLING_HISTORY_REQUIRED');
  const events = contract.events;
  const active = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i], t = event.terms;
    const start = Math.max(p.start, event.at, t.hasValidityPeriod ? t.validityStartsAt : p.start);
    const end = Math.min(p.end, events[i + 1]?.at ?? p.end, t.hasValidityPeriod ? t.validityEndsAt : p.end);
    if (!(end > start) || t.status !== 'approved') continue;
    if (t.partnerID !== 'self' || t.plan === 'trial') continue;
    if (!PLANS[t.plan]) fail('CUSTOM_CONTRACT_REVIEW_REQUIRED');
    if (t.pricingVersion !== '2026-10-v1') fail('CUSTOM_CONTRACT_REVIEW_REQUIRED');
    active.push({ start, end, terms: t });
  }
  if (!active.length) return null;
  const first = active[0], last = active[active.length - 1];
  // 月途中の移管・複数プラン・即時停止の料金は未合意。推測して請求しない。
  if (active.some(item => item.terms.plan !== first.terms.plan) || last.end < p.end
    || active.some((item, i) => i > 0 && active[i - 1].end !== item.start))
    fail('CONTRACT_CHANGE_REVIEW_REQUIRED');
  if (events.some((e, i) => i > 0 && e.at > p.start && e.at < p.end
    && e.terms.partnerID !== events[i - 1].terms.partnerID))
    fail('CONTRACT_CHANGE_REVIEW_REQUIRED');
  const t = last.terms;
  if (t.limitMilliseconds !== PLANS[t.plan].hours * HOUR) fail('CUSTOM_ALLOWANCE_REVIEW_REQUIRED');
  const days = p.days - Math.floor((first.start - p.start) / DAY);
  const totals = Object.fromEntries(['realtime', 'mediaFile', 'formalTranslation'].map(key => [key, usage?.[key] ?? 0]));
  if (Object.values(totals).some(n => !Number.isSafeInteger(n) || n < 0)) fail('INVALID_BILLING_USAGE');
  return { ...price(t.plan, days, p.days, Object.values(totals).reduce((a, b) => a + b, 0)),
    month, periodStart: p.start, periodEnd: p.end, billingStart: first.start, usage: totals, terms: t,
    domain: t.domain, organizationName: t.organizationName, email: t.contactEmail,
    portalAccountID: t.portalAccountID, contractID: contract.id,
    contractDigest: hash(JSON.stringify(events.filter(e => e.at < p.end))) };
}

module.exports = { DAY, JST, HOUR, PLANS, hash, fail, time, monthAt, period, monthsUntil, contractID, terms, price, calculate };
