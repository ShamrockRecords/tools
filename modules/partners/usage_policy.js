// 純粋な計算のみ。本モジュールはDB・個人残高・ネットワークを操作しない。
const fail = code => { throw Object.assign(new Error(code), { code }); };
const milliseconds = value => {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_USAGE');
  return value;
};

function nextUsage(row, request) {
  if (!row.corporate) fail('NOT_CORPORATE');
  if (row.userID !== request.userID) fail('RESERVATION_NOT_FOUND');
  if (request.clientRequest && row.operation === 'formalTranslation') fail('RESERVATION_SERVER_MANAGED');
  const amount = milliseconds(request.consumedMilliseconds);
  const previous = milliseconds(row.consumedMilliseconds);
  const finish = request.finish === true;
  if (['completed', 'cancelled'].includes(row.status)) {
    if (!finish) fail('RESERVATION_CLOSED');
    return { row, delta: 0, changed: false };
  }
  if (!['held', 'consuming'].includes(row.status)) fail('RESERVATION_CLOSED');
  if (!finish) {
    if (!Number.isSafeInteger(request.sequence) || request.sequence <= 0) fail('INVALID_SEQUENCE');
    if (request.sequence <= row.sequence) return { row, delta: 0, changed: false };
  }
  const consumed = row.operation === 'realtime' ? Math.max(previous, amount)
    : finish ? Math.min(milliseconds(row.requestedMilliseconds), amount) : previous;
  if (consumed < previous) fail('INVALID_USAGE');
  return { row: { ...row, consumedMilliseconds: consumed,
    sequence: finish ? row.sequence : request.sequence,
    status: finish ? (request.cancelled ? 'cancelled' : 'completed') : row.status,
  }, delta: consumed - previous, changed: true };
}

function monthAt(ms) { return new Date(ms + 9 * 3600000).toISOString().slice(0, 7); }
module.exports = { nextUsage, monthAt };
