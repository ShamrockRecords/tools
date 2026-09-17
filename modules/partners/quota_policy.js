const HOUR = 3600000;
const JST = 9 * HOUR;
const timestamp = value => value?.toDate ? value.toDate().getTime() : new Date(value || 0).getTime();
const resetDay = row => row.resetDay || (row.approvedAt ? new Date(timestamp(row.approvedAt) + JST).getUTCDate() : 1);

// 月末の短い月でも、翌月は元の指定日に戻す。
function boundary(year, month, day) {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(day, last)) - JST;
}
function periodAt(now, row) {
  const date = new Date(now + JST), day = resetDay(row);
  let year = date.getUTCFullYear(), month = date.getUTCMonth();
  if (now < boundary(year, month, day)) month -= 1;
  const start = boundary(year, month, day), end = boundary(year, month + 1, day);
  return { start, end, key: `${new Date(start + JST).toISOString().slice(0, 10)}_${day}` };
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
  const day = Number(input.resetDay);
  if ((hours !== null && (!Number.isFinite(hours) || hours < 0 || !Number.isSafeInteger(limitMilliseconds)))
      || !Number.isInteger(day) || day < 1 || day > 31)
    throw Object.assign(new Error('上限時間とリセット日（1〜31日）を確認してください。'), { code: 'INVALID_QUOTA' });
  return { limitMilliseconds, resetDay: day,
    stopAtLimit: input.stopAtLimit === 'on' || input.stopAtLimit === true,
    notifyAtOneHour: input.notifyAtOneHour === 'on' || input.notifyAtOneHour === true };
}
module.exports = { HOUR, timestamp, resetDay, boundary, periodAt, quotaStatus, parseQuota };
