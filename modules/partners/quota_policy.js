const HOUR = 3600000;
const JST = 9 * HOUR;
const timestamp = value => value?.toDate ? value.toDate().getTime() : new Date(value || 0).getTime();
// 法人は開始日・旧設定にかかわらず日本時間の毎月1日にリセットする。
const resetDay = () => 1;

// 月末の短い月でも、翌月は元の指定日に戻す。
function boundary(year, month, day) {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(day, last)) - JST;
}
function periodAt(now, row) {
  if (row.plan === 'trial') {
    const start = timestamp(row.validityStartsAt || row.approvedAt || row.createdAt);
    const end = row.validityEndsAt == null ? 8640000000000000 : timestamp(row.validityEndsAt);
    return { start, end, key: `trial_${start}_${end}` };
  }
  const date = new Date(now + JST), day = resetDay(row);
  let year = date.getUTCFullYear(), month = date.getUTCMonth();
  if (now < boundary(year, month, day)) month -= 1;
  const start = boundary(year, month, day), end = boundary(year, month + 1, day);
  return { start, end, key: `monthly_${new Date(start + JST).toISOString().slice(0, 10)}` };
}
function quotaStatus(row, used) {
  const limit = row.limitMilliseconds ?? null;
  const blocked = limit !== null && row.stopAtLimit === true && used >= limit;
  return { usageAllowed: !blocked, usageBlockedReason: blocked ? 'CORPORATE_LIMIT_REACHED' : null,
    limitMilliseconds: limit, usedMilliseconds: used,
    remainingMilliseconds: limit === null ? null : Math.max(0, limit - used),
    excessMilliseconds: limit === null ? 0 : Math.max(0, used - limit) };
}
function parseQuota(input) {
  const hours = input.limitHours === '' ? null : Number(input.limitHours);
  const limitMilliseconds = hours === null ? null : Math.round(hours * HOUR);
  if (hours !== null && (!Number.isFinite(hours) || hours < 0 || !Number.isSafeInteger(limitMilliseconds)))
    throw Object.assign(new Error('上限時間を確認してください。'), { code: 'INVALID_QUOTA' });
  return { limitMilliseconds, resetDay: 1,
    stopAtLimit: input.stopAtLimit === 'on' || input.stopAtLimit === true,
    notifyAtOneHour: input.notifyAtOneHour === 'on' || input.notifyAtOneHour === true };
}
const planLimitHours = { metered: '0', light: '50', standard: '100', custom: '' };
module.exports = { HOUR, timestamp, resetDay, boundary, periodAt, quotaStatus, parseQuota, planLimitHours };
