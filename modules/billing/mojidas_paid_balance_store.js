const { getFirestore } = require('../firestore');
const { mojidasCollection } = require('../mojidas_firestore');

const REPORTING_THRESHOLD_JPY = 10_000_000;

class MojidasPaidBalanceStore {
  constructor({ firestoreProvider = getFirestore, now = () => Date.now() } = {}) {
    this.firestoreProvider = firestoreProvider;
    this.now = now;
  }

  async getReport() {
    const [grantSnapshot, ledgerSnapshot, heldSnapshot, consumingSnapshot] = await Promise.all([
      this.collection('creditGrants').where('type', '==', 'purchased').get(),
      this.collection('usageLedger').where('kind', '==', 'grant').get(),
      this.collection('creditReservations').where('status', '==', 'held').get(),
      this.collection('creditReservations').where('status', '==', 'consuming').get(),
    ]);

    return summarizePaidBalance({
      grantDocuments: grantSnapshot.docs,
      ledgerDocuments: ledgerSnapshot.docs,
      reservationDocuments: [...heldSnapshot.docs, ...consumingSnapshot.docs],
      now: new Date(this.now()),
    });
  }

  get firestore() {
    return this.firestoreProvider();
  }

  collection(name) {
    return mojidasCollection(this.firestore, name);
  }
}

function summarizePaidBalance({
  grantDocuments,
  ledgerDocuments,
  reservationDocuments = [],
  now,
}) {
  const ledgerMetadataByGrantID = new Map();
  ledgerDocuments.forEach((document) => {
    const data = document.data();
    if (data && data.grantID && data.metadata) {
      ledgerMetadataByGrantID.set(data.grantID, data.metadata);
    }
  });

  const reservedMillisecondsByGrantID = unconsumedReservationsByGrant(
    reservationDocuments
  );
  const activeGrants = grantDocuments
    .map((document) => {
      const data = document.data();
      return {
        id: document.id,
        ...data,
        effectiveRemainingMilliseconds: positiveNumber(data.remainingMilliseconds)
          + (reservedMillisecondsByGrantID.get(document.id) || 0),
      };
    })
    .filter((grant) => grant.effectiveRemainingMilliseconds > 0)
    .filter((grant) => !asDate(grant.startsAt) || asDate(grant.startsAt) <= now)
    .filter((grant) => !asDate(grant.expiresAt) || asDate(grant.expiresAt) > now);

  const breakdownByProduct = new Map();
  let knownAmountJPY = 0;
  let valuedRemainingMilliseconds = 0;
  let unvaluedRemainingMilliseconds = 0;
  let unvaluedGrantCount = 0;

  activeGrants.forEach((grant) => {
    const metadata = validPurchaseMetadata(grant.metadata)
      || validPurchaseMetadata(ledgerMetadataByGrantID.get(grant.id));
    const remainingMilliseconds = grant.effectiveRemainingMilliseconds;
    const totalMilliseconds = positiveNumber(grant.totalMilliseconds);

    if (!metadata || totalMilliseconds <= 0) {
      unvaluedGrantCount += 1;
      unvaluedRemainingMilliseconds += remainingMilliseconds;
      return;
    }

    const amountJPY = remainingMilliseconds * metadata.totalJPY / totalMilliseconds;
    knownAmountJPY += amountJPY;
    valuedRemainingMilliseconds += remainingMilliseconds;

    const key = metadata.productID || 'product-unknown';
    const current = breakdownByProduct.get(key) || {
      productID: metadata.productID,
      label: grant.label || metadata.productID || '商品情報なし',
      grantCount: 0,
      remainingMilliseconds: 0,
      amountJPY: 0,
    };
    current.grantCount += 1;
    current.remainingMilliseconds += remainingMilliseconds;
    current.amountJPY += amountJPY;
    breakdownByProduct.set(key, current);
  });

  const totalRemainingMilliseconds = activeGrants.reduce(
    (sum, grant) => sum + grant.effectiveRemainingMilliseconds,
    0
  );
  const isComplete = unvaluedGrantCount === 0;
  const unusedPaidBalanceJPY = isComplete ? Math.ceil(knownAmountJPY) : null;

  return {
    asOf: now,
    isComplete,
    unusedPaidBalanceJPY,
    knownUnusedPaidBalanceJPY: Math.ceil(knownAmountJPY),
    exactKnownAmountJPY: knownAmountJPY,
    totalRemainingMilliseconds,
    valuedRemainingMilliseconds,
    unvaluedRemainingMilliseconds,
    purchaseGrantCount: activeGrants.length,
    unvaluedGrantCount,
    reportingThresholdJPY: REPORTING_THRESHOLD_JPY,
    thresholdUsageRate: unusedPaidBalanceJPY === null
      ? null
      : unusedPaidBalanceJPY / REPORTING_THRESHOLD_JPY,
    breakdown: Array.from(breakdownByProduct.values())
      .sort((left, right) => right.amountJPY - left.amountJPY),
  };
}

function unconsumedReservationsByGrant(documents) {
  const totals = new Map();
  documents.forEach((document) => {
    const reservation = document.data();
    if (!reservation || !['held', 'consuming'].includes(reservation.status)) return;
    let consumptionLeft = positiveNumber(reservation.consumedMilliseconds);
    const allocations = Array.isArray(reservation.allocations) ? reservation.allocations : [];
    allocations.forEach((allocation) => {
      const allocated = positiveNumber(allocation && allocation.milliseconds);
      const used = Math.min(allocated, consumptionLeft);
      consumptionLeft -= used;
      const unconsumed = allocated - used;
      const grantID = allocation && allocation.grantID;
      if (unconsumed > 0 && typeof grantID === 'string' && grantID) {
        totals.set(grantID, (totals.get(grantID) || 0) + unconsumed);
      }
    });
  });
  return totals;
}

function validPurchaseMetadata(value) {
  if (!value || typeof value !== 'object') return null;
  const totalJPY = Number(value.totalJPY);
  if (!Number.isSafeInteger(totalJPY) || totalJPY <= 0) return null;
  return {
    totalJPY,
    productID: typeof value.productID === 'string' && value.productID.trim()
      ? value.productID.trim()
      : null,
  };
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function asDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value.toDate === 'function') return asDate(value.toDate());
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

module.exports = new MojidasPaidBalanceStore();
module.exports.MojidasPaidBalanceStore = MojidasPaidBalanceStore;
module.exports.REPORTING_THRESHOLD_JPY = REPORTING_THRESHOLD_JPY;
module.exports.summarizePaidBalance = summarizePaidBalance;
module.exports.unconsumedReservationsByGrant = unconsumedReservationsByGrant;
