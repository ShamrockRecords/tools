const crypto = require('crypto');
const { getFirestore } = require('../firestore');
const { mojidasCollection } = require('../mojidas_firestore');
const { monthlyFreeMilliseconds } = require('../mojidas_service_configuration');

const MONTHLY_FREE_MILLISECONDS = monthlyFreeMilliseconds();
const RESERVATION_LEASE_MILLISECONDS = 10 * 60 * 1000;
const MEDIA_RESERVATION_GRACE_MILLISECONDS = 30 * 60 * 1000;
const UNLIMITED_AVAILABLE_MILLISECONDS = 100 * 365 * 24 * 60 * 60 * 1000;

class CreditStoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CreditStoreError';
    this.code = code;
    this.details = details;
  }
}

class MojidasCreditStore {
  constructor({
    firestoreProvider = getFirestore,
    now = () => Date.now(),
    monthlyFreeAllowanceMilliseconds = MONTHLY_FREE_MILLISECONDS,
  } = {}) {
    this.firestoreProvider = firestoreProvider;
    this.now = now;
    this.monthlyFreeAllowanceMilliseconds = monthlyFreeAllowanceMilliseconds;
    this.signupGiftStartsAt = null;
  }

  async getBalance({ userID, accountCreatedAt, isUnlimited = false }) {
    await this.ensureAccountGrants({ userID, accountCreatedAt, isUnlimited });
    await this.releaseExpiredReservations(userID);
    const snapshot = await this.collection('creditGrants')
      .where('userID', '==', userID)
      .get();
    return {
      ...summarizeGrants(eligibleGrantDocuments(snapshot.docs, isUnlimited), new Date(this.now())),
      isUnlimited,
    };
  }

  async ensureAccountGrants({ userID, accountCreatedAt, isUnlimited = false }) {
    await this.ensureMonthlyGrant({ userID, accountCreatedAt });
    await this.ensureSignupGift({ userID, accountCreatedAt });
    if (isUnlimited) {
      // テスト残高も通常と同じgrantの予約・消費・返却を通す。売上には含めない。
      await this.grantCredit({
        userID,
        type: 'testCredit',
        label: 'テスト用時間',
        milliseconds: UNLIMITED_AVAILABLE_MILLISECONDS,
        idempotencyKey: 'invited-test-credit-v1',
        metadata: { testOnly: true },
      });
    }
  }

  // 最初の新規登録要求より前に開始日時を固定する。再デプロイでも変えない。
  async activateSignupGift() {
    const document = this.collection('configuration').doc('signupGift');
    const now = new Date(this.now());
    await this.firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(document);
      if (!snapshot.exists) transaction.set(document, { startsAt: now });
    });
  }

  async ensureSignupGift({ userID, accountCreatedAt }) {
    const createdAt = asDate(accountCreatedAt);
    if (!createdAt || Number.isNaN(createdAt.getTime())) return;
    if (!this.signupGiftStartsAt) {
      const snapshot = await this.collection('configuration').doc('signupGift').get();
      this.signupGiftStartsAt = snapshot.exists ? asDate(snapshot.data().startsAt) : null;
    }
    const startsAt = this.signupGiftStartsAt;
    if (!startsAt || createdAt < startsAt) return;
    await this.grantCredit({
      userID,
      type: 'promotional',
      label: '新規登録プレゼント（1時間）',
      milliseconds: 60 * 60 * 1000,
      idempotencyKey: 'signup-gift-v1',
      metadata: { reason: '新規登録プレゼント', campaign: 'signup-gift-v1' },
    });
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
        totalMilliseconds: this.monthlyFreeAllowanceMilliseconds,
        remainingMilliseconds: this.monthlyFreeAllowanceMilliseconds,
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
          milliseconds: this.monthlyFreeAllowanceMilliseconds,
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
    rejectConflictingRetry = false,
  }) {
    const amount = Math.floor(Number(milliseconds));
    const normalizedType = String(type || '').trim();
    const normalizedKey = String(idempotencyKey || '').trim();
    const startDate = startsAt ? asDate(startsAt) : new Date(this.now());
    const expiryDate = expiresAt ? asDate(expiresAt) : null;
    if (!userID || !normalizedType || !normalizedKey || !startDate || !Number.isSafeInteger(amount) || amount <= 0) {
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
      if (snapshot.exists) {
        if (rejectConflictingRetry && (snapshot.data().type !== normalizedType
          || snapshot.data().totalMilliseconds !== amount)) {
          throw new CreditStoreError('IDEMPOTENCY_CONFLICT', 'この追加操作は既に別の時間で処理されています。画面を再読込してください。');
        }
        return;
      }
      transaction.set(document, {
        userID,
        type: normalizedType,
        label: typeof label === 'string' && label.trim() ? label.trim() : null,
        totalMilliseconds: amount,
        remainingMilliseconds: amount,
        startsAt: startDate,
        expiresAt: expiryDate,
        sourceReference: sourceReference || normalizedKey,
        metadata: { ...metadata },
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

  async consumeTranslation({
    userID,
    accountCreatedAt,
    idempotencyKey,
    requestFingerprint,
    milliseconds,
    sourceSessionID,
    targetLanguageCode,
    isUnlimited = false,
  }) {
    const normalizedUserID = normalizeLedgerIdentifier(userID);
    const normalizedKey = normalizeLedgerIdentifier(idempotencyKey);
    const normalizedRequestFingerprint = normalizeRequestFingerprint(requestFingerprint);
    const normalizedSessionID = normalizeLedgerIdentifier(sourceSessionID);
    const normalizedTargetLanguage = normalizeLanguageCode(targetLanguageCode);
    const billableMilliseconds = Number(milliseconds);
    if (
      !normalizedUserID
      || !normalizedKey
      || !normalizedRequestFingerprint
      || !normalizedSessionID
      || !normalizedTargetLanguage
      || !Number.isSafeInteger(billableMilliseconds)
      || billableMilliseconds < 0
      || billableMilliseconds > 7 * 24 * 60 * 60 * 1000
    ) {
      throw new CreditStoreError('INVALID_TRANSLATION_USAGE', '翻訳時間の消費内容が不正です。');
    }

    await this.ensureAccountGrants({ userID: normalizedUserID, accountCreatedAt, isUnlimited });
    await this.releaseExpiredReservations(normalizedUserID);

    const now = new Date(this.now());
    const ledgerID = deterministicID(
      'translation-consume',
      `${normalizedUserID}:${normalizedKey}`
    );
    const ledgerDocument = this.collection('usageLedger').doc(ledgerID);
    return this.firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(ledgerDocument);
      if (existing.exists) {
        const data = existing.data();
        const metadata = data.metadata || {};
        if (
          data.userID !== normalizedUserID
          || data.idempotencyKey !== `translation:${normalizedKey}`
          || metadata.operation !== 'formalTranslation'
          || metadata.sourceSessionID !== normalizedSessionID
          || metadata.targetLanguageCode !== normalizedTargetLanguage
          || metadata.requestFingerprint !== normalizedRequestFingerprint
          || Number(metadata.billableMilliseconds) !== billableMilliseconds
        ) {
          throw new CreditStoreError(
            'IDEMPOTENCY_CONFLICT',
            '同じ冪等キーが異なる翻訳時間に使用されています。'
          );
        }
        return {
          billableMilliseconds,
          chargedMilliseconds: Math.max(0, -(Number(data.milliseconds) || 0)),
          isUnlimited: Boolean(metadata.unlimited),
          alreadyConsumed: true,
        };
      }

      let allocations = [];
      if (billableMilliseconds > 0) {
        const grantQuery = this.collection('creditGrants')
          .where('userID', '==', normalizedUserID);
        const grantSnapshot = await transaction.get(grantQuery);
        const allocation = allocateFromGrants(
          activeGrantDocuments(eligibleGrantDocuments(grantSnapshot.docs, isUnlimited), now),
          billableMilliseconds
        );
        if (allocation.remaining > 0) {
          throw insufficientCreditError(billableMilliseconds, allocation.available);
        }
        allocations = allocation.allocations.map((item) => ({
          grantID: item.id,
          milliseconds: item.milliseconds,
        }));
        allocation.allocations.forEach((item) => {
          transaction.update(item.document, {
            remainingMilliseconds: item.remainingAfter,
            updatedAt: now,
          });
        });
      }

      const chargedMilliseconds = billableMilliseconds;
      transaction.set(ledgerDocument, {
        userID: normalizedUserID,
        grantID: null,
        reservationID: null,
        kind: 'consume',
        milliseconds: chargedMilliseconds === 0 ? 0 : -chargedMilliseconds,
        idempotencyKey: `translation:${normalizedKey}`,
        occurredAt: now,
        metadata: {
          operation: 'formalTranslation',
          sourceSessionID: normalizedSessionID,
          targetLanguageCode: normalizedTargetLanguage,
          requestFingerprint: normalizedRequestFingerprint,
          billableMilliseconds,
          unlimited: Boolean(isUnlimited),
          allocations,
        },
      });
      return {
        billableMilliseconds,
        chargedMilliseconds,
        isUnlimited: Boolean(isUnlimited),
        alreadyConsumed: false,
      };
    });
  }

  async createReservation({
    userID,
    accountCreatedAt,
    operation,
    clientSessionID,
    recognitionRunID,
    requestedMilliseconds,
    trackCount,
    isUnlimited = false,
  }) {
    await this.ensureAccountGrants({ userID, accountCreatedAt, isUnlimited });
    await this.releaseExpiredReservations(userID);

    const now = new Date(this.now());
    const reservationID = deterministicID('reservation', `${userID}:${recognitionRunID}`);
    const reservationDocument = this.collection('creditReservations')
      .doc(reservationID);

    return this.firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(reservationDocument);
      if (existing.exists) {
        const reservation = existing.data();
        const sameActiveReservation = (
          reservation.userID === userID
          && reservation.recognitionRunID === recognitionRunID
          && ['held', 'consuming'].includes(reservation.status)
        );
        const sameReservationIdentity = reservation.operation === operation
          && reservation.clientSessionID === clientSessionID;
        const sameRequestedTime = operation !== 'formalTranslation'
          || Number(reservation.requestedMilliseconds) === Number(requestedMilliseconds);
        if (sameActiveReservation && sameReservationIdentity && sameRequestedTime) {
          return {
            ...publicReservation(reservationID, reservation),
            alreadyReserved: true,
          };
        }
        if (sameActiveReservation) {
          throw new CreditStoreError(
            'IDEMPOTENCY_CONFLICT',
            '同じ翻訳操作IDが異なる予約内容に使用されています。'
          );
        }
        throw new CreditStoreError(
          'RESERVATION_EXPIRED',
          '同じ認識処理の利用時間予約は既に終了しています。'
        );
      }

      const grantQuery = this.collection('creditGrants')
        .where('userID', '==', userID);
      const grantSnapshot = await transaction.get(grantQuery);

      const grants = activeGrantDocuments(eligibleGrantDocuments(grantSnapshot.docs, isUnlimited), now);
      const isRealtime = operation === 'realtime';
      const allocation = allocateFromGrants(
        grants,
        isRealtime ? 0 : requestedMilliseconds
      );
      if (isRealtime && allocation.available <= 0) {
        throw insufficientCreditError(1, 0);
      }
      if (!isRealtime && allocation.remaining > 0) {
        throw insufficientCreditError(requestedMilliseconds, allocation.available);
      }
      const allocatedMilliseconds = isRealtime
        ? 0
        : requestedMilliseconds - allocation.remaining;
      const ledgerKind = isRealtime ? 'start' : 'reserve';

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
        unlimited: Boolean(isUnlimited),
        accountingVersion: 2,
        accountCreatedAt: asDate(accountCreatedAt) || new Date(0),
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
        this.collection('usageLedger').doc(deterministicID(ledgerKind, reservationID)),
        {
          userID,
          grantID: null,
          reservationID,
          kind: ledgerKind,
          milliseconds: allocatedMilliseconds === 0 ? 0 : -allocatedMilliseconds,
          idempotencyKey: `${ledgerKind}:${reservationID}`,
          occurredAt: now,
          metadata: { operation, trackCount, unlimited: Boolean(isUnlimited) },
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
    isUnlimited = false,
    clientRequest = false,
  }) {
    await this.ensureAccountGrants({ userID, accountCreatedAt, isUnlimited });
    const now = new Date(this.now());
    const document = this.collection('creditReservations').doc(reservationID);

    const outcome = await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(document);
      const reservation = requireOwnedReservation(snapshot, userID);
      assertClientReservation(reservation, clientRequest);
      if (reservation.operation === 'formalTranslation') requireActiveReservation(snapshot, userID, now);
      else if (!['held', 'consuming', 'expired'].includes(reservation.status)) {
        throw new CreditStoreError('RESERVATION_CLOSED', 'この認識処理は既に終了しています。');
      }
      const previousSequence = Number(reservation.lastHeartbeatSequence) || 0;
      const previousConsumed = Number(reservation.consumedMilliseconds) || 0;
      if (sequence <= previousSequence) {
        return {
          reservation: publicReservation(reservationID, reservation),
          insufficient: Boolean(reservation.lastHeartbeatInsufficient),
          requiredMilliseconds: Number(reservation.reportedMilliseconds) || previousConsumed,
          availableMilliseconds: Number(reservation.requestedMilliseconds) || 0,
        };
      }
      const isMediaFile = reservation.operation === 'mediaFile';
      const reportedConsumed = isMediaFile ? 0 : consumedMilliseconds;
      if (!isMediaFile && reportedConsumed < Math.max(previousConsumed, Number(reservation.reportedMilliseconds) || 0)) {
        throw new CreditStoreError(
          'INVALID_SEQUENCE',
          '音声認識時間が前回の報告より小さくなっています。'
        );
      }

      let requestedMilliseconds = Number(reservation.requestedMilliseconds) || 0;
      let allocations = reservation.allocations || [];
      let insufficient = false;
      const needsMediaBacking = isMediaFile && (reservation.status === 'expired'
        || (reservation.unlimited && !reservation.accountingVersion));
      if (needsMediaBacking) {
        const grants = await transaction.get(this.collection('creditGrants').where('userID', '==', userID));
        const reacquired = allocateFromGrants(
          activeGrantDocuments(eligibleGrantDocuments(grants.docs, isUnlimited), now), requestedMilliseconds
        );
        if (reacquired.remaining > 0) throw insufficientCreditError(requestedMilliseconds, reacquired.available);
        allocations = reacquired.allocations.map((item) => ({ grantID: item.id, milliseconds: item.milliseconds }));
        reacquired.allocations.forEach((item) => transaction.update(item.document, {
          remainingMilliseconds: item.remainingAfter, updatedAt: now,
        }));
        transaction.set(this.collection('usageLedger').doc(deterministicID('recover', `${reservationID}:${sequence}`)), {
          userID, reservationID, grantID: null, kind: 'reserve',
          milliseconds: requestedMilliseconds === 0 ? 0 : -requestedMilliseconds,
          idempotencyKey: `recover:${reservationID}:${sequence}`, occurredAt: now,
          metadata: { operation: reservation.operation, unlimited: Boolean(reservation.unlimited) },
        });
      }
      if (reservation.operation === 'realtime') {
        const requiredConsumption = Math.max(0, reportedConsumed - requestedMilliseconds);
        if (requiredConsumption > 0) {
          const grantQuery = this.collection('creditGrants')
            .where('userID', '==', userID);
          const grantSnapshot = await transaction.get(grantQuery);
          const extension = allocateFromGrants(
            activeGrantDocuments(eligibleGrantDocuments(grantSnapshot.docs, isUnlimited), now),
            requiredConsumption
          );
          const allocated = requiredConsumption - extension.remaining;
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
                deterministicID('consume', `${reservationID}:${sequence}`)
              ),
              {
                userID,
                grantID: null,
                reservationID,
                kind: 'consume',
                milliseconds: -allocated,
                idempotencyKey: `consume:${reservationID}:${sequence}`,
                occurredAt: now,
                metadata: { sequence },
              }
            );
          }
          insufficient = allocated < requiredConsumption;
        }
      }
      const chargedConsumedMilliseconds = Math.min(
        reportedConsumed,
        requestedMilliseconds
      );

      const updated = {
        ...reservation,
        requestedMilliseconds,
        allocations,
        consumedMilliseconds: chargedConsumedMilliseconds,
        lastHeartbeatSequence: sequence,
        lastHeartbeatInsufficient: insufficient,
        reportedMilliseconds: reportedConsumed,
        accountingVersion: 2,
        leaseGeneration: (Number(reservation.leaseGeneration) || 0)
          + (isMediaFile && reservation.status === 'expired' ? 1 : 0),
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
        lastHeartbeatInsufficient: updated.lastHeartbeatInsufficient,
        reportedMilliseconds: updated.reportedMilliseconds,
        accountingVersion: updated.accountingVersion,
        leaseGeneration: updated.leaseGeneration,
        status: updated.status,
        leaseExpiresAt: updated.leaseExpiresAt,
        updatedAt: now,
      });
      return {
        reservation: publicReservation(reservationID, updated),
        insufficient,
        requiredMilliseconds: reportedConsumed,
        availableMilliseconds: requestedMilliseconds,
      };
    });
    if (outcome.insufficient) {
      throw insufficientCreditError(
        outcome.requiredMilliseconds,
        outcome.availableMilliseconds
      );
    }
    return outcome.reservation;
  }

  async completeReservation({ reservationID, userID, accountCreatedAt, isUnlimited, consumedMilliseconds, cancelled = false, clientRequest = false }) {
    // 長い切断中に月が変わっていても、確定前に当月の無料枠を用意する。
    if (accountCreatedAt) await this.ensureAccountGrants({ userID, accountCreatedAt, isUnlimited });
    return this.finalizeReservation({
      reservationID,
      userID,
      consumedMilliseconds,
      status: cancelled ? 'cancelled' : 'completed',
      clientRequest,
      isUnlimited,
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

  async finalizeReservation({ reservationID, userID, consumedMilliseconds, status, clientRequest = false, isUnlimited }) {
    const now = new Date(this.now());
    const reservationDocument = this.collection('creditReservations')
      .doc(reservationID);

    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reservationDocument);
      if (!snapshot.exists || snapshot.data().userID !== userID) {
        throw new CreditStoreError('RESERVATION_NOT_FOUND', '利用時間の予約が見つかりません。');
      }
      const reservation = snapshot.data();
      const mayUseTestCredit = isUnlimited === undefined ? reservation.unlimited : isUnlimited;
      assertClientReservation(reservation, clientRequest);
      if (['completed', 'cancelled'].includes(reservation.status)
        || (reservation.status === 'expired' && status === 'expired')) {
        return publicReservation(reservationID, reservation);
      }
      if (status === 'expired') {
        // 候補検索後にheartbeatが期限を延長することがあるため、
        // 終了を書き込むtransaction内で最新の期限を再確認する。
        const leaseExpiresAt = asDate(reservation.leaseExpiresAt);
        if (leaseExpiresAt && leaseExpiresAt.getTime() > now.getTime()) {
          return publicReservation(reservationID, reservation);
        }
      }

      let requested = Math.max(0, Number(reservation.requestedMilliseconds) || 0);
      let allocations = reservation.allocations || [];
      const isFixedReservation = ['mediaFile', 'formalTranslation'].includes(
        reservation.operation
      );
      const reported = isFixedReservation
        ? Math.max(0, Number(consumedMilliseconds) || 0)
        : Math.max(
          Number(reservation.consumedMilliseconds) || 0,
          Number(consumedMilliseconds) || 0
        );
      let additionalAllocation = null;
      let additionalMilliseconds = 0;

      // リアルタイム認識は開始時に時間を予約しない。停止直前など、最後の
      // heartbeat以降に確定した発話時間だけをここで追加消費する。
      if (!isFixedReservation && reported > requested) {
        const requiredConsumption = reported - requested;
        const grantQuery = this.collection('creditGrants')
          .where('userID', '==', userID);
        const grantSnapshot = await transaction.get(grantQuery);
        additionalAllocation = allocateFromGrants(
          activeGrantDocuments(eligibleGrantDocuments(grantSnapshot.docs, mayUseTestCredit), now),
          requiredConsumption
        );
        additionalMilliseconds = requiredConsumption - additionalAllocation.remaining;
        requested += additionalMilliseconds;
        allocations = mergeAllocations(
          allocations,
          additionalAllocation.allocations.map((item) => ({
            grantID: item.id,
            milliseconds: item.milliseconds,
          }))
        );
      }

      // ファイル予約は期限切れで返却済みの場合、確定分を改めて確保する。
      // 不足時はtransaction全体を中止し、アプリ側の未送信確定として保持する。
      if (isFixedReservation && (reservation.status === 'expired'
        || (status !== 'expired' && reservation.unlimited && !reservation.accountingVersion))) {
        if (reservation.operation === 'formalTranslation' && reservation.status === 'expired') {
          throw new CreditStoreError('RESERVATION_EXPIRED', '翻訳用の予約期限が切れています。');
        }
        const amount = Math.min(requested, reported);
        const grants = await transaction.get(this.collection('creditGrants').where('userID', '==', userID));
        additionalAllocation = allocateFromGrants(
          activeGrantDocuments(eligibleGrantDocuments(grants.docs, mayUseTestCredit), now), amount
        );
        if (additionalAllocation.remaining > 0) {
          throw insufficientCreditError(amount, additionalAllocation.available);
        }
        requested = amount;
        allocations = additionalAllocation.allocations.map((item) => ({ grantID: item.id, milliseconds: item.milliseconds }));
        additionalMilliseconds = amount;
      }
      let consumed;
      if (reservation.operation === 'formalTranslation' && status === 'completed') {
        // 正式翻訳はserverが算出した課金対象時間を全量予約している。
        consumed = requested;
      } else if (reservation.operation === 'mediaFile' && status === 'completed') {
        // ファイル長を上限として予約し、正常完了後はクライアントが
        // 確定結果から算出した実発話時間だけを消費し、差額を返却する。
        consumed = Math.min(requested, reported);
      } else if (isFixedReservation && status === 'expired') {
        // 完了通知がないまま期限切れになった予約は、サービス側の失敗として全返却する。
        consumed = 0;
      } else {
        consumed = Math.min(requested, reported);
      }
      let remainingConsumption = consumed;
      const releases = [];
      allocations.forEach((allocation) => {
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

      if (additionalAllocation) {
        additionalAllocation.allocations.forEach((item) => {
          transaction.update(item.document, {
            remainingMilliseconds: item.remainingAfter,
            updatedAt: now,
          });
        });
      }

      grantSnapshots.forEach((grant) => {
        if (!grant.snapshot.exists) return;
        const current = Math.max(0, Number(grant.snapshot.data().remainingMilliseconds) || 0);
        transaction.update(grant.document, {
          remainingMilliseconds: current + grant.milliseconds,
          updatedAt: now,
        });
      });

      const releasedMilliseconds = releases.reduce((total, release) => total + release.milliseconds, 0);
      const updated = {
        ...reservation,
        requestedMilliseconds: requested,
        allocations,
        consumedMilliseconds: consumed,
        status,
        completedAt: now,
        updatedAt: now,
      };
      transaction.update(reservationDocument, {
        requestedMilliseconds: requested,
        allocations,
        consumedMilliseconds: consumed,
        status,
        completedAt: now,
        updatedAt: now,
      });
      if (additionalMilliseconds > 0) {
        transaction.set(
          this.collection('usageLedger').doc(deterministicID('finalize-charge', reservationID)),
          {
            userID,
            grantID: null,
            reservationID,
            kind: 'consume',
            milliseconds: -additionalMilliseconds,
            idempotencyKey: `finalize-charge:${reservationID}`,
            occurredAt: now,
            metadata: { status },
          }
        );
      }
      if (releasedMilliseconds > 0) {
        const releaseKey = reservation.leaseGeneration
          ? `${reservationID}:${reservation.leaseGeneration}` : reservationID;
        transaction.set(
          this.collection('usageLedger').doc(deterministicID('release', releaseKey)),
          {
            userID,
            grantID: null,
            reservationID,
            kind: 'release',
            milliseconds: releasedMilliseconds,
            idempotencyKey: `release:${releaseKey}`,
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
    isUnlimited: false,
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
      // 無料・キャンペーン枠をすべて使い切ってから購入分を消費する。
      // purchasedに将来有効期限が付いても、この商品仕様を優先する。
      const leftPurchased = left.data.type === 'testCredit' ? 2 : left.data.type === 'purchased' ? 1 : 0;
      const rightPurchased = right.data.type === 'testCredit' ? 2 : right.data.type === 'purchased' ? 1 : 0;
      if (leftPurchased !== rightPurchased) return leftPurchased - rightPurchased;
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

function eligibleGrantDocuments(documents, isUnlimited) {
  return documents.filter((document) => isUnlimited || document.data().type !== 'testCredit');
}

function assertClientReservation(reservation, clientRequest) {
  if (clientRequest && reservation.operation === 'formalTranslation') {
    throw new CreditStoreError('RESERVATION_SERVER_MANAGED', '正式翻訳の利用時間はサーバーが確定します。');
  }
}

function requireOwnedReservation(snapshot, userID) {
  if (!snapshot.exists || snapshot.data().userID !== userID) {
    throw new CreditStoreError('RESERVATION_NOT_FOUND', '利用時間の予約が見つかりません。');
  }
  return snapshot.data();
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
    isUnlimited: Boolean(reservation.unlimited),
    requestedMilliseconds: Number(reservation.requestedMilliseconds) || 0,
    leaseExpiresAt: asDate(reservation.leaseExpiresAt),
    status: reservation.status,
    consumedMilliseconds: Number(reservation.consumedMilliseconds) || 0,
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

function normalizeLedgerIdentifier(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized && normalized.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(normalized)
    ? normalized
    : '';
}

function normalizeLanguageCode(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized && normalized.length <= 64
    && /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/.test(normalized)
    ? normalized
    : '';
}

function normalizeRequestFingerprint(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : '';
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
module.exports.RESERVATION_LEASE_MILLISECONDS = RESERVATION_LEASE_MILLISECONDS;
module.exports.UNLIMITED_AVAILABLE_MILLISECONDS = UNLIMITED_AVAILABLE_MILLISECONDS;
module.exports.reservationLeaseMilliseconds = reservationLeaseMilliseconds;
module.exports.addUTCMonths = addUTCMonths;
module.exports.allocateFromGrants = allocateFromGrants;
module.exports.asDate = asDate;
module.exports.deterministicID = deterministicID;
module.exports.monthlyPeriod = monthlyPeriod;
module.exports.mergeAllocations = mergeAllocations;
module.exports.summarizeGrants = summarizeGrants;
