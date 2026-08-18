const crypto = require('crypto');
const { getFirestore } = require('../firestore');
const { mojidasCollection } = require('../mojidas_firestore');

const MONTHLY_FREE_MILLISECONDS = 60 * 60 * 1000;
const REALTIME_CHUNK_MILLISECONDS = 5 * 60 * 1000;
const RESERVATION_LEASE_MILLISECONDS = 10 * 60 * 1000;
const MEDIA_RESERVATION_GRACE_MILLISECONDS = 30 * 60 * 1000;

class CreditStoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CreditStoreError';
    this.code = code;
    this.details = details;
  }
}

class MojidasCreditStore {
  constructor({ firestoreProvider = getFirestore, now = () => Date.now() } = {}) {
    this.firestoreProvider = firestoreProvider;
    this.now = now;
  }

  async getBalance({ userID, accountCreatedAt }) {
    await this.ensureMonthlyGrant({ userID, accountCreatedAt });
    await this.releaseExpiredReservations(userID);
    const snapshot = await this.collection('creditGrants')
      .where('userID', '==', userID)
      .get();
    return summarizeGrants(snapshot.docs, new Date(this.now()));
  }

  async ensureMonthlyGrant({ userID, accountCreatedAt }) {
    const now = new Date(this.now());
    const period = monthlyPeriod(accountCreatedAt || new Date(0), now);
    const grantID = deterministicID('monthly', `${userID}:${period.startsAt.toISOString()}`);
    const document = this.collection('creditGrants').doc(grantID);

    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(document);
      if (snapshot.exists) return;
      transaction.set(document, {
        userID,
        type: 'monthlyFree',
        totalMilliseconds: MONTHLY_FREE_MILLISECONDS,
        remainingMilliseconds: MONTHLY_FREE_MILLISECONDS,
        startsAt: period.startsAt,
        expiresAt: period.expiresAt,
        sourceReference: `monthlyFree:${period.startsAt.toISOString()}`,
        createdAt: now,
      });
      transaction.set(
        this.collection('usageLedger').doc(deterministicID('grant', grantID)),
        {
          userID,
          grantID,
          reservationID: null,
          kind: 'grant',
          milliseconds: MONTHLY_FREE_MILLISECONDS,
          idempotencyKey: `grant:${grantID}`,
          occurredAt: now,
          metadata: { type: 'monthlyFree' },
        }
      );
    });
    return grantID;
  }

  async grantCredit({
    userID,
    type,
    label = null,
    milliseconds,
    startsAt = null,
    expiresAt = null,
    sourceReference = null,
    idempotencyKey,
    metadata = {},
  }) {
    const amount = Math.floor(Number(milliseconds));
    const normalizedType = String(type || '').trim();
    const normalizedKey = String(idempotencyKey || '').trim();
    const startDate = startsAt ? asDate(startsAt) : new Date(this.now());
    const expiryDate = expiresAt ? asDate(expiresAt) : null;
    if (!userID || !normalizedType || !normalizedKey || !startDate || amount <= 0) {
      throw new CreditStoreError('INVALID_GRANT', '利用時間の付与内容が不正です。');
    }
    if (expiresAt && !expiryDate) {
      throw new CreditStoreError('INVALID_GRANT', '利用時間の有効期限が不正です。');
    }
    if (expiryDate && expiryDate.getTime() <= startDate.getTime()) {
      throw new CreditStoreError('INVALID_GRANT', '利用時間の有効期限は開始日時より後にしてください。');
    }

    const now = new Date(this.now());
    const grantID = deterministicID('credit', `${userID}:${normalizedKey}`);
    const document = this.collection('creditGrants').doc(grantID);
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(document);
      if (snapshot.exists) return;
      transaction.set(document, {
        userID,
        type: normalizedType,
        label: typeof label === 'string' && label.trim() ? label.trim() : null,
        totalMilliseconds: amount,
        remainingMilliseconds: amount,
        startsAt: startDate,
        expiresAt: expiryDate,
        sourceReference: sourceReference || normalizedKey,
        createdAt: now,
      });
      transaction.set(
        this.collection('usageLedger').doc(deterministicID('grant', grantID)),
        {
          userID,
          grantID,
          reservationID: null,
          kind: 'grant',
          milliseconds: amount,
          idempotencyKey: normalizedKey,
          occurredAt: now,
          metadata: { ...metadata, type: normalizedType, label: label || null },
        }
      );
    });
    return grantID;
  }

  async createReservation({
    userID,
    accountCreatedAt,
    operation,
    clientSessionID,
    recognitionRunID,
    requestedMilliseconds,
    trackCount,
  }) {
    await this.ensureMonthlyGrant({ userID, accountCreatedAt });
    await this.releaseExpiredReservations(userID);

    const now = new Date(this.now());
    const reservationID = deterministicID('reservation', `${userID}:${recognitionRunID}`);
    const reservationDocument = this.collection('creditReservations')
      .doc(reservationID);
    const grantQuery = this.collection('creditGrants')
      .where('userID', '==', userID);

    return this.firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(reservationDocument);
      const grantSnapshot = await transaction.get(grantQuery);
      if (existing.exists) {
        const reservation = existing.data();
        if (
          reservation.userID === userID
          && reservation.recognitionRunID === recognitionRunID
          && ['held', 'consuming'].includes(reservation.status)
        ) {
          return publicReservation(reservationID, reservation);
        }
        throw new CreditStoreError(
          'RESERVATION_EXPIRED',
          '同じ認識処理の利用時間予約は既に終了しています。'
        );
      }

      const grants = activeGrantDocuments(grantSnapshot.docs, now);
      const allocation = allocateFromGrants(grants, requestedMilliseconds);
      const allocatedMilliseconds = requestedMilliseconds - allocation.remaining;
      if (
        allocation.remaining > 0
        && (operation !== 'realtime' || allocatedMilliseconds <= 0)
      ) {
        throw insufficientCreditError(requestedMilliseconds, allocation.available);
      }

      allocation.allocations.forEach((item) => {
        transaction.update(item.document, {
          remainingMilliseconds: item.remainingAfter,
          updatedAt: now,
        });
      });

      const reservation = {
        userID,
        operation,
        clientSessionID,
        recognitionRunID,
        requestedMilliseconds: allocatedMilliseconds,
        trackCount,
        allocations: allocation.allocations.map((item) => ({
          grantID: item.id,
          milliseconds: item.milliseconds,
        })),
        consumedMilliseconds: 0,
        status: 'held',
        leaseExpiresAt: new Date(now.getTime() + reservationLeaseMilliseconds(
          operation,
          allocatedMilliseconds
        )),
        lastHeartbeatSequence: 0,
        createdAt: now,
        updatedAt: now,
      };
      transaction.set(reservationDocument, reservation);
      transaction.set(
        this.collection('usageLedger').doc(deterministicID('reserve', reservationID)),
        {
          userID,
          grantID: null,
          reservationID,
          kind: 'reserve',
          milliseconds: -allocatedMilliseconds,
          idempotencyKey: `reserve:${reservationID}`,
          occurredAt: now,
          metadata: { operation, trackCount },
        }
      );
      return publicReservation(reservationID, reservation);
    });
  }

  async heartbeat({
    reservationID,
    userID,
    accountCreatedAt,
    sequence,
    consumedMilliseconds,
  }) {
    await this.ensureMonthlyGrant({ userID, accountCreatedAt });
    const now = new Date(this.now());
    const document = this.collection('creditReservations').doc(reservationID);

    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(document);
      const reservation = requireActiveReservation(snapshot, userID, now);
      const previousSequence = Number(reservation.lastHeartbeatSequence) || 0;
      const previousConsumed = Number(reservation.consumedMilliseconds) || 0;
      if (sequence <= previousSequence) return publicReservation(reservationID, reservation);
      const isMediaFile = reservation.operation === 'mediaFile';
      const reportedConsumed = isMediaFile ? 0 : consumedMilliseconds;
      if (reportedConsumed < previousConsumed) {
        throw new CreditStoreError(
          'INVALID_SEQUENCE',
          '音声認識時間が前回の報告より小さくなっています。'
        );
      }

      let requestedMilliseconds = Number(reservation.requestedMilliseconds) || 0;
      let allocations = reservation.allocations || [];
      if (reservation.operation === 'realtime') {
        const trackCount = Math.max(1, Number(reservation.trackCount) || 1);
        const extensionLead = 60 * 1000 * trackCount;
        if (requestedMilliseconds - reportedConsumed <= extensionLead) {
          const desiredExtension = REALTIME_CHUNK_MILLISECONDS * trackCount;
          const grantQuery = this.collection('creditGrants')
            .where('userID', '==', userID);
          const grantSnapshot = await transaction.get(grantQuery);
          const extension = allocateFromGrants(
            activeGrantDocuments(grantSnapshot.docs, now),
            desiredExtension
          );
          const allocated = desiredExtension - extension.remaining;
          const requiredToCoverConsumption = Math.max(0, reportedConsumed - requestedMilliseconds);
          if (
            allocated < requiredToCoverConsumption
            || (allocated <= 0 && reportedConsumed >= requestedMilliseconds)
          ) {
            throw insufficientCreditError(
              reportedConsumed + extensionLead,
              requestedMilliseconds + extension.available
            );
          }
          if (allocated > 0) {
            extension.allocations.forEach((item) => {
              transaction.update(item.document, {
                remainingMilliseconds: item.remainingAfter,
                updatedAt: now,
              });
            });
            requestedMilliseconds += allocated;
            allocations = mergeAllocations(
              allocations,
              extension.allocations.map((item) => ({
                grantID: item.id,
                milliseconds: item.milliseconds,
              }))
            );
            transaction.set(
              this.collection('usageLedger').doc(
                deterministicID('extend', `${reservationID}:${sequence}`)
              ),
              {
                userID,
                grantID: null,
                reservationID,
                kind: 'reserve',
                milliseconds: -allocated,
                idempotencyKey: `extend:${reservationID}:${sequence}`,
                occurredAt: now,
                metadata: { sequence },
              }
            );
          }
        }
      }
      if (reportedConsumed > requestedMilliseconds) {
        throw insufficientCreditError(reportedConsumed, requestedMilliseconds);
      }

      const updated = {
        ...reservation,
        requestedMilliseconds,
        allocations,
        consumedMilliseconds: reportedConsumed,
        lastHeartbeatSequence: sequence,
        status: 'consuming',
        leaseExpiresAt: new Date(now.getTime() + reservationLeaseMilliseconds(
          reservation.operation,
          requestedMilliseconds
        )),
        updatedAt: now,
      };
      transaction.update(document, {
        requestedMilliseconds: updated.requestedMilliseconds,
        allocations: updated.allocations,
        consumedMilliseconds: updated.consumedMilliseconds,
        lastHeartbeatSequence: updated.lastHeartbeatSequence,
        status: updated.status,
        leaseExpiresAt: updated.leaseExpiresAt,
        updatedAt: now,
      });
      return publicReservation(reservationID, updated);
    });
  }

  async completeReservation({ reservationID, userID, consumedMilliseconds, cancelled = false }) {
    return this.finalizeReservation({
      reservationID,
      userID,
      consumedMilliseconds,
      status: cancelled ? 'cancelled' : 'completed',
    });
  }

  async assertActiveReservation({ reservationID, userID }) {
    const snapshot = await this.collection('creditReservations')
      .doc(reservationID)
      .get();
    return requireActiveReservation(snapshot, userID, new Date(this.now()));
  }

  async releaseExpiredReservations(userID) {
    const now = new Date(this.now());
    const snapshot = await this.collection('creditReservations')
      .where('userID', '==', userID)
      .get();
    const expired = snapshot.docs.filter((document) => {
      const reservation = document.data();
      const leaseExpiresAt = asDate(reservation.leaseExpiresAt);
      return ['held', 'consuming'].includes(reservation.status)
        && (!leaseExpiresAt || leaseExpiresAt.getTime() <= now.getTime());
    });
    await Promise.all(expired.map((document) => this.finalizeReservation({
      reservationID: document.id,
      userID,
      consumedMilliseconds: Number(document.data().consumedMilliseconds) || 0,
      status: 'expired',
    })));
  }

  async finalizeReservation({ reservationID, userID, consumedMilliseconds, status }) {
    const now = new Date(this.now());
    const reservationDocument = this.collection('creditReservations')
      .doc(reservationID);

    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reservationDocument);
      if (!snapshot.exists || snapshot.data().userID !== userID) {
        throw new CreditStoreError('RESERVATION_NOT_FOUND', '利用時間の予約が見つかりません。');
      }
      const reservation = snapshot.data();
      if (['completed', 'cancelled', 'expired'].includes(reservation.status)) {
        return publicReservation(reservationID, reservation);
      }

      const requested = Math.max(0, Number(reservation.requestedMilliseconds) || 0);
      const isMediaFile = reservation.operation === 'mediaFile';
      let consumed;
      if (isMediaFile && status === 'completed') {
        // ファイル認識は正常完了した場合だけ、予約した全時間を消費する。
        consumed = requested;
      } else if (isMediaFile && status === 'expired') {
        // 完了通知がないまま期限切れになった予約は、サービス側の失敗として全返却する。
        consumed = 0;
      } else {
        const reported = isMediaFile
          ? Math.max(0, Number(consumedMilliseconds) || 0)
          : Math.max(
            Number(reservation.consumedMilliseconds) || 0,
            Number(consumedMilliseconds) || 0
          );
        consumed = Math.min(requested, reported);
      }
      let remainingConsumption = consumed;
      const releases = [];
      (reservation.allocations || []).forEach((allocation) => {
        const allocated = Math.max(0, Number(allocation.milliseconds) || 0);
        const used = Math.min(allocated, remainingConsumption);
        remainingConsumption -= used;
        const released = allocated - used;
        if (released > 0) releases.push({ grantID: allocation.grantID, milliseconds: released });
      });

      const grantSnapshots = [];
      for (const release of releases) {
        const grantDocument = this.collection('creditGrants').doc(release.grantID);
        const grantSnapshot = await transaction.get(grantDocument);
        grantSnapshots.push({ ...release, document: grantDocument, snapshot: grantSnapshot });
      }

      grantSnapshots.forEach((grant) => {
        if (!grant.snapshot.exists) return;
        const current = Math.max(0, Number(grant.snapshot.data().remainingMilliseconds) || 0);
        transaction.update(grant.document, {
          remainingMilliseconds: current + grant.milliseconds,
          updatedAt: now,
        });
      });

      const releasedMilliseconds = Math.max(0, requested - consumed);
      const updated = {
        ...reservation,
        consumedMilliseconds: consumed,
        status,
        completedAt: now,
        updatedAt: now,
      };
      transaction.update(reservationDocument, {
        consumedMilliseconds: consumed,
        status,
        completedAt: now,
        updatedAt: now,
      });
      if (releasedMilliseconds > 0) {
        transaction.set(
          this.collection('usageLedger').doc(deterministicID('release', reservationID)),
          {
            userID,
            grantID: null,
            reservationID,
            kind: 'release',
            milliseconds: releasedMilliseconds,
            idempotencyKey: `release:${reservationID}`,
            occurredAt: now,
            metadata: { status },
          }
        );
      }
      return publicReservation(reservationID, updated);
    });
  }

  get firestore() {
    return this.firestoreProvider();
  }

  collection(name) {
    return mojidasCollection(this.firestore, name);
  }
}

function monthlyPeriod(accountCreatedAt, currentTime) {
  const anchor = asDate(accountCreatedAt);
  const now = asDate(currentTime);
  if (!anchor || !now) throw new CreditStoreError('INVALID_ACCOUNT_DATE', 'アカウント作成日時が不正です。');
  let monthOffset = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12
    + now.getUTCMonth() - anchor.getUTCMonth();
  let startsAt = addUTCMonths(anchor, Math.max(0, monthOffset));
  if (startsAt.getTime() > now.getTime()) {
    monthOffset = Math.max(0, monthOffset - 1);
    startsAt = addUTCMonths(anchor, monthOffset);
  }
  return {
    startsAt,
    expiresAt: addUTCMonths(anchor, monthOffset + 1),
  };
}

function addUTCMonths(anchor, monthOffset) {
  const targetMonth = anchor.getUTCMonth() + monthOffset;
  const targetYear = anchor.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    targetYear,
    normalizedMonth,
    Math.min(anchor.getUTCDate(), lastDay),
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds()
  ));
}

function summarizeGrants(documents, now) {
  const grants = activeGrantDocuments(documents, now).map((grant) => ({
    id: grant.id,
    type: grant.data.type,
    label: grant.data.label || null,
    remainingMilliseconds: grant.remainingMilliseconds,
    expiresAt: asDate(grant.data.expiresAt),
  }));
  const expiringMilliseconds = grants
    .filter((grant) => grant.expiresAt)
    .reduce((total, grant) => total + grant.remainingMilliseconds, 0);
  const purchasedMilliseconds = grants
    .filter((grant) => grant.type === 'purchased' && !grant.expiresAt)
    .reduce((total, grant) => total + grant.remainingMilliseconds, 0);
  return {
    availableMilliseconds: grants.reduce(
      (total, grant) => total + grant.remainingMilliseconds,
      0
    ),
    expiringMilliseconds,
    purchasedMilliseconds,
    grants,
    serverTime: now,
  };
}

function activeGrantDocuments(documents, now) {
  return documents
    .map((document) => {
      const data = document.data();
      return {
        id: document.id,
        document: document.ref,
        data,
        remainingMilliseconds: Math.max(0, Number(data.remainingMilliseconds) || 0),
        startsAt: asDate(data.startsAt),
        expiresAt: asDate(data.expiresAt),
        createdAt: asDate(data.createdAt),
      };
    })
    .filter((grant) => grant.remainingMilliseconds > 0)
    .filter((grant) => !grant.startsAt || grant.startsAt.getTime() <= now.getTime())
    .filter((grant) => !grant.expiresAt || grant.expiresAt.getTime() > now.getTime())
    .sort((left, right) => {
      const leftExpiry = left.expiresAt ? left.expiresAt.getTime() : Number.MAX_SAFE_INTEGER;
      const rightExpiry = right.expiresAt ? right.expiresAt.getTime() : Number.MAX_SAFE_INTEGER;
      if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
      return (left.createdAt?.getTime() || 0) - (right.createdAt?.getTime() || 0);
    });
}

function allocateFromGrants(grants, requestedMilliseconds) {
  let remaining = requestedMilliseconds;
  let available = 0;
  const allocations = [];
  grants.forEach((grant) => {
    available += grant.remainingMilliseconds;
    if (remaining <= 0) return;
    const milliseconds = Math.min(grant.remainingMilliseconds, remaining);
    allocations.push({
      ...grant,
      milliseconds,
      remainingAfter: grant.remainingMilliseconds - milliseconds,
    });
    remaining -= milliseconds;
  });
  return { allocations, available, remaining };
}

function mergeAllocations(existing, additions) {
  const order = [];
  const totals = new Map();
  [...existing, ...additions].forEach((allocation) => {
    if (!totals.has(allocation.grantID)) order.push(allocation.grantID);
    totals.set(
      allocation.grantID,
      (totals.get(allocation.grantID) || 0) + (Number(allocation.milliseconds) || 0)
    );
  });
  return order.map((grantID) => ({ grantID, milliseconds: totals.get(grantID) }));
}

function requireActiveReservation(snapshot, userID, now) {
  if (!snapshot.exists || snapshot.data().userID !== userID) {
    throw new CreditStoreError('RESERVATION_NOT_FOUND', '利用時間の予約が見つかりません。');
  }
  const reservation = snapshot.data();
  if (!['held', 'consuming'].includes(reservation.status)) {
    throw new CreditStoreError('RESERVATION_EXPIRED', '利用時間の予約は終了しています。');
  }
  const leaseExpiresAt = asDate(reservation.leaseExpiresAt);
  if (!leaseExpiresAt || leaseExpiresAt.getTime() <= now.getTime()) {
    throw new CreditStoreError('RESERVATION_EXPIRED', '利用時間の予約期限が切れています。');
  }
  return reservation;
}

function reservationLeaseMilliseconds(operation, requestedMilliseconds) {
  if (operation !== 'mediaFile') return RESERVATION_LEASE_MILLISECONDS;
  return Math.max(
    RESERVATION_LEASE_MILLISECONDS,
    Math.max(0, Number(requestedMilliseconds) || 0) + MEDIA_RESERVATION_GRACE_MILLISECONDS
  );
}

function publicReservation(id, reservation) {
  return {
    id,
    requestedMilliseconds: Number(reservation.requestedMilliseconds) || 0,
    leaseExpiresAt: asDate(reservation.leaseExpiresAt),
  };
}

function insufficientCreditError(required, available) {
  return new CreditStoreError(
    'INSUFFICIENT_CREDIT',
    '音声認識時間が不足しています。',
    {
      requiredMilliseconds: required,
      availableMilliseconds: available,
      shortfallMilliseconds: Math.max(0, required - available),
    }
  );
}

function deterministicID(prefix, value) {
  return `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

function asDate(value) {
  if (!value) return null;
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
module.exports.MONTHLY_FREE_MILLISECONDS = MONTHLY_FREE_MILLISECONDS;
module.exports.MojidasCreditStore = MojidasCreditStore;
module.exports.MEDIA_RESERVATION_GRACE_MILLISECONDS = MEDIA_RESERVATION_GRACE_MILLISECONDS;
module.exports.REALTIME_CHUNK_MILLISECONDS = REALTIME_CHUNK_MILLISECONDS;
module.exports.RESERVATION_LEASE_MILLISECONDS = RESERVATION_LEASE_MILLISECONDS;
module.exports.reservationLeaseMilliseconds = reservationLeaseMilliseconds;
module.exports.addUTCMonths = addUTCMonths;
module.exports.allocateFromGrants = allocateFromGrants;
module.exports.asDate = asDate;
module.exports.deterministicID = deterministicID;
module.exports.monthlyPeriod = monthlyPeriod;
module.exports.mergeAllocations = mergeAllocations;
module.exports.summarizeGrants = summarizeGrants;
