// 月別実績は残高差分ではなく消費履歴・確定予約から集計する。読み取り専用。
function summarizeMonthlyCredits({ grantDocuments, ledgerDocuments, reservationDocuments, now }) {
  const grants = new Map(grantDocuments.map(doc => [doc.id, doc.data()]));
  const ledger = ledgerDocuments.map(doc => ({ id: doc.id, ...doc.data() }));
  const reservations = new Map(reservationDocuments.map(doc => [doc.id, doc.data()]));
  const grantEvents = new Map(ledger.filter(item => item.kind === 'grant').map(item => [item.grantID, item]));
  const rows = new Map();
  let undatedRecords = 0;
  const rowAt = value => {
    const date = asDate(value);
    if (!date) { undatedRecords += 1; return null; }
    if (date > now) return null;
    const month = new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
    if (!rows.has(month)) rows.set(month, { month, monthlyFree: 0, purchased: 0, promotional: 0,
      unknown: 0, total: 0, purchasedMilliseconds: 0, purchaseJPY: 0, unvaluedPurchases: 0 });
    return rows.get(month);
  };
  const typeOf = allocation => allocation.type || grants.get(allocation.grantID)?.type
    || grantEvents.get(allocation.grantID)?.metadata?.type;
  const addUsage = (date, amount, allocations = []) => {
    if (!(amount > 0)) return;
    const row = rowAt(date);
    if (!row) return;
    let left = amount;
    for (const allocation of allocations) {
      const used = Math.min(left, positive(allocation.milliseconds));
      left -= used;
      const type = typeOf(allocation);
      if (type === 'testCredit') continue;
      const key = ['monthlyFree', 'purchased', 'promotional'].includes(type) ? type : 'unknown';
      row[key] += used;
      row.total += used;
    }
    row.unknown += left;
    row.total += left;
  };

  // 返金取消・リリース時のテスト清算は購入月から除外する。
  // 決済記録を残すため、残高ゼロだけでは取消と判断しない。
  for (const id of new Set([...grants.keys(), ...grantEvents.keys()])) {
    const grant = grants.get(id), event = grantEvents.get(id);
    if ((grant?.type || event?.metadata?.type) !== 'purchased') continue;
    if (grant?.refundAdjustmentRun || grant?.releaseReset) continue;
    const row = rowAt(event?.occurredAt || grant?.createdAt);
    if (!row) continue;
    row.purchasedMilliseconds += positive(event?.milliseconds ?? grant?.totalMilliseconds);
    const amount = grant?.metadata?.totalJPY ?? event?.metadata?.totalJPY;
    if (Number.isSafeInteger(amount) && amount > 0) row.purchaseJPY += amount;
    else row.unvaluedPurchases += 1;
  }

  // ファイル・正式翻訳は完了月に確定量を計上。予約・返却・再予約を足さない。
  for (const reservation of reservations.values()) {
    if (['mediaFile', 'formalTranslation'].includes(reservation.operation)
      && ['completed', 'cancelled', 'expired'].includes(reservation.status)) {
      addUsage(reservation.completedAt, positive(reservation.consumedMilliseconds), reservation.allocations);
    }
  }
  for (const event of ledger) {
    if (event.kind !== 'consume') continue;
    const reservation = reservations.get(event.reservationID);
    if (reservation && ['mediaFile', 'formalTranslation'].includes(reservation.operation)) continue;
    // 古いリアルタイム履歴は単一区分なら復元可能。混在時に順序を推測しない。
    let allocations = event.metadata?.allocations;
    if (!allocations && reservation?.operation === 'realtime') {
      const types = new Set((reservation.allocations || []).map(typeOf));
      if (types.size === 1 && !types.has(undefined)) {
        allocations = [{ type: [...types][0], milliseconds: -event.milliseconds }];
      }
    }
    addUsage(event.occurredAt, positive(-event.milliseconds), allocations);
  }
  // 実績のない月も現在月まではゼロ行を表示する。
  rowAt(now);
  const earliest = [...rows.keys()].sort()[0];
  if (earliest) {
    const cursor = new Date(`${earliest}-01T00:00:00Z`);
    while (cursor <= now) { rowAt(cursor); cursor.setUTCMonth(cursor.getUTCMonth() + 1); }
  }
  return { rows: [...rows.values()].sort((a, b) => b.month.localeCompare(a.month)), undatedRecords };
}

function positive(value) { return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0; }
function asDate(value) {
  if (!value) return null;
  const date = typeof value.toDate === 'function' ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

module.exports = { summarizeMonthlyCredits };
