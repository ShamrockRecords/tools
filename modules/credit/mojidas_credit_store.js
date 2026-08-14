const { getFirestore } = require('../firestore');

class CreditStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CreditStoreError';
    this.code = code;
  }
}

class MojidasCreditStore {
  async assertActiveReservation({ reservationID, userID }) {
    const snapshot = await getFirestore()
      .collection('creditReservations')
      .doc(reservationID)
      .get();

    if (!snapshot.exists) {
      throw new CreditStoreError('RESERVATION_NOT_FOUND', '利用時間の予約が見つかりません。');
    }

    const reservation = snapshot.data();
    if (reservation.userID !== userID) {
      throw new CreditStoreError('RESERVATION_NOT_FOUND', '利用時間の予約が見つかりません。');
    }
    if (!['held', 'consuming'].includes(reservation.status)) {
      throw new CreditStoreError('RESERVATION_EXPIRED', '利用時間の予約は終了しています。');
    }

    const leaseExpiresAt = asDate(reservation.leaseExpiresAt);
    if (!leaseExpiresAt || leaseExpiresAt.getTime() <= Date.now()) {
      throw new CreditStoreError('RESERVATION_EXPIRED', '利用時間の予約期限が切れています。');
    }

    return reservation;
  }
}

function asDate(value) {
  if (value && typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

module.exports = new MojidasCreditStore();
module.exports.CreditStoreError = CreditStoreError;
module.exports.MojidasCreditStore = MojidasCreditStore;
