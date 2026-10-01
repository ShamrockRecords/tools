const { summarizeMonthlyCredits } = require('./mojidas_monthly_credit_report');

function validMonth(month) {
  return typeof month === 'string' && /^(20\d{2})-(0[1-9]|1[0-2])$/.test(month);
}

// 月別集計と同じ確定消費を日別に集計する。残高・予約には書き込まない。
function summarizeDailyUsage(documents, month) {
  if (!validMonth(month)) throw new RangeError('対象月が不正です。');
  const personal = summarizeMonthlyCredits({ ...documents, dailyMonth: month });
  const byDate = new Map(personal.rows.map(row => [row.month, row]));
  const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  const rows = Array.from({ length: days }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`;
    const item = byDate.get(date) || {};
    return { date, free: (item.monthlyFree || 0) + (item.promotional || 0),
      paid: item.purchased || 0, unknown: item.unknown || 0, corporate: 0, total: item.total || 0 };
  });
  let undatedRecords = personal.undatedRecords;
  for (const document of documents.corporateDocuments || []) {
    const item = document.data();
    if (!(item.milliseconds > 0)) continue;
    const date = item.occurredAt?.toDate ? item.occurredAt.toDate() : new Date(item.occurredAt || NaN);
    if (Number.isNaN(date.getTime())) { undatedRecords += 1; continue; }
    if (date > documents.now) continue;
    const day = new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10);
    if (day.slice(0, 7) !== month) continue;
    const row = rows[Number(day.slice(8)) - 1];
    row.corporate += item.milliseconds;
    row.total += item.milliseconds;
  }
  const totals = { free: 0, paid: 0, unknown: 0, corporate: 0, total: 0 };
  for (const row of rows) for (const key of Object.keys(totals)) totals[key] += row[key];
  return { month, rows, totals, undatedRecords, asOf: documents.now };
}

module.exports = { validMonth, summarizeDailyUsage };
