const crypto = require('crypto');

const DEFAULT_TTL_MILLISECONDS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_OPERATION_TIMEOUT_MILLISECONDS = 2 * 60 * 1000;

class FormalTranslationJobStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FormalTranslationJobStoreError';
    this.code = code;
  }
}

class MemoryFormalTranslationJobStore {
  constructor({
    now = () => Date.now(),
    ttlMilliseconds = DEFAULT_TTL_MILLISECONDS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    operationTimeoutMilliseconds = DEFAULT_OPERATION_TIMEOUT_MILLISECONDS,
  } = {}) {
    this.now = now;
    this.ttlMilliseconds = ttlMilliseconds;
    this.maxEntries = maxEntries;
    this.operationTimeoutMilliseconds = operationTimeoutMilliseconds;
    this.entriesByID = new Map();
    this.jobIDByOperationKey = new Map();
  }

  start({ userID, idempotencyKey, requestFingerprint, operation }) {
    this.removeExpiredEntries();
    const operationKey = `${userID}:${idempotencyKey}`;
    const existingID = this.jobIDByOperationKey.get(operationKey);
    const existing = existingID ? this.entriesByID.get(existingID) : null;
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new FormalTranslationJobStoreError(
          'IDEMPOTENCY_CONFLICT',
          '同じ冪等キーが異なる翻訳内容に使用されています。'
        );
      }
      return publicJob(existing);
    }

    if (this.entriesByID.size >= this.maxEntries) {
      this.removeOldestEntry();
    }
    const timestamp = this.now();
    const entry = {
      jobID: crypto.randomUUID(),
      operationKey,
      userID,
      requestFingerprint,
      status: 'processing',
      result: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: timestamp + this.ttlMilliseconds,
    };
    this.entriesByID.set(entry.jobID, entry);
    this.jobIDByOperationKey.set(operationKey, entry.jobID);

    // HTTPリクエストの寿命と切り離し、Herokuの30秒router timeoutを回避する。
    const abortController = new AbortController();
    const operationPromise = Promise.resolve().then(() => operation(abortController.signal));
    entry.promise = withTimeout(
      operationPromise,
      this.operationTimeoutMilliseconds,
      abortController
    )
      .then((result) => {
        entry.status = 'completed';
        entry.result = result;
        entry.updatedAt = this.now();
        entry.expiresAt = entry.updatedAt + this.ttlMilliseconds;
      })
      .catch((error) => {
        entry.status = 'failed';
        entry.error = error;
        entry.updatedAt = this.now();
        entry.expiresAt = entry.updatedAt + this.ttlMilliseconds;
      });
    return publicJob(entry);
  }

  get({ jobID, userID }) {
    this.removeExpiredEntries();
    const entry = this.entriesByID.get(jobID);
    if (!entry || entry.userID !== userID) return null;
    return publicJob(entry);
  }

  removeExpiredEntries() {
    const timestamp = this.now();
    for (const entry of this.entriesByID.values()) {
      if (entry.expiresAt <= timestamp) this.removeEntry(entry);
    }
  }

  removeOldestEntry() {
    const oldest = this.entriesByID.values().next().value;
    if (oldest) this.removeEntry(oldest);
  }

  removeEntry(entry) {
    this.entriesByID.delete(entry.jobID);
    if (this.jobIDByOperationKey.get(entry.operationKey) === entry.jobID) {
      this.jobIDByOperationKey.delete(entry.operationKey);
    }
  }
}

function withTimeout(operation, timeoutMilliseconds, abortController) {
  let timeoutID;
  const timeout = new Promise((resolve, reject) => {
    timeoutID = setTimeout(() => {
      reject(new FormalTranslationJobStoreError(
        'TRANSLATION_JOB_TIMEOUT',
        '翻訳処理が制限時間を超えました。自動再送は行っていません。'
      ));
      abortController.abort();
    }, timeoutMilliseconds);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timeoutID));
}

function publicJob(entry) {
  return {
    jobID: entry.jobID,
    status: entry.status,
    result: entry.result,
    error: entry.error,
  };
}

module.exports = {
  FormalTranslationJobStoreError,
  MemoryFormalTranslationJobStore,
};
