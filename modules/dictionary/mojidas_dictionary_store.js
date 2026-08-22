const crypto = require('crypto');

const { getFirestore } = require('../firestore');
const { mojidasCollection } = require('../mojidas_firestore');

const MAXIMUM_WORD_COUNT = 1000;
const MAXIMUM_MUTATIONS_PER_REQUEST = 100;

class DictionaryStoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DictionaryStoreError';
    this.code = code;
    this.details = details;
  }
}

class MojidasDictionaryStore {
  constructor({ firestoreProvider = getFirestore, now = () => Date.now() } = {}) {
    this.firestoreProvider = firestoreProvider;
    this.now = now;
  }

  async getChanges({ userID, afterRevision = 0 }) {
    const normalizedUserID = normalizeRequiredString(userID, 'INVALID_USER');
    const revision = normalizeRevision(afterRevision);
    const accountDocument = this.accountDocument(normalizedUserID);
    const [accountSnapshot, wordsSnapshot] = await Promise.all([
      accountDocument.get(),
      accountDocument.collection('words')
        .where('serverRevision', '>', revision)
        .orderBy('serverRevision', 'asc')
        .get(),
    ]);
    const account = accountSnapshot.exists ? accountSnapshot.data() : {};
    const changes = wordsSnapshot.docs
      .map((document) => publicWord(document.data()))
      .sort((lhs, rhs) => lhs.serverRevision - rhs.serverRevision);

    return {
      revision: Number.isSafeInteger(account.revision) ? account.revision : 0,
      updatedAt: asDate(account.updatedAt),
      changes,
    };
  }

  async synchronize({ userID, deviceID, mutations }) {
    const normalizedUserID = normalizeRequiredString(userID, 'INVALID_USER');
    const normalizedDeviceID = normalizeUUID(deviceID, 'INVALID_DEVICE_ID');
    const normalizedMutations = normalizeMutations(mutations);
    const accountDocument = this.accountDocument(normalizedUserID);
    const clientDocument = this.clientDocument(normalizedUserID, normalizedDeviceID);
    const wordDocuments = new Map();
    for (const mutation of normalizedMutations) {
      if (!wordDocuments.has(mutation.wordID)) {
        wordDocuments.set(
          mutation.wordID,
          this.wordDocument(normalizedUserID, mutation.wordID)
        );
      }
    }

    return this.firestore.runTransaction(async (transaction) => {
      const accountSnapshot = await transaction.get(accountDocument);
      const clientSnapshot = await transaction.get(clientDocument);
      const wordSnapshots = new Map();
      for (const [wordID, document] of wordDocuments) {
        wordSnapshots.set(wordID, await transaction.get(document));
      }

      const account = accountSnapshot.exists ? accountSnapshot.data() : {};
      const client = clientSnapshot.exists ? clientSnapshot.data() : {};
      let revision = Number.isSafeInteger(account.revision) ? account.revision : 0;
      let wordCount = Number.isSafeInteger(account.wordCount) ? account.wordCount : 0;
      let acceptedThroughSequence = Number.isSafeInteger(client.lastSequence)
        ? client.lastSequence
        : 0;
      const words = new Map();
      for (const [wordID, snapshot] of wordSnapshots) {
        words.set(wordID, snapshot.exists ? snapshot.data() : null);
      }

      const accepted = [];
      for (const mutation of normalizedMutations) {
        if (mutation.sequence <= acceptedThroughSequence) continue;
        if (mutation.sequence !== acceptedThroughSequence + 1) {
          throw new DictionaryStoreError(
            'INVALID_SEQUENCE',
            '単語辞書の更新順序が正しくありません。',
            { acceptedThroughSequence }
          );
        }

        const previous = words.get(mutation.wordID);
        const wasActive = Boolean(previous && !previous.deleted);
        const willBeActive = mutation.operation === 'upsert';
        const nextCount = wordCount + (willBeActive ? 1 : 0) - (wasActive ? 1 : 0);
        if (nextCount > MAXIMUM_WORD_COUNT) {
          throw new DictionaryStoreError(
            'WORD_LIMIT_REACHED',
            `Mojidasに登録できる単語は最大${MAXIMUM_WORD_COUNT}語です。`,
            { maximumWordCount: MAXIMUM_WORD_COUNT }
          );
        }

        revision += 1;
        acceptedThroughSequence = mutation.sequence;
        wordCount = Math.max(0, nextCount);
        const now = new Date(this.now());
        const next = mutation.operation === 'delete'
          ? {
            userID: normalizedUserID,
            id: mutation.wordID,
            written: previous && previous.written ? previous.written : '',
            spoken: previous && previous.spoken ? previous.spoken : '',
            isEnabled: false,
            deleted: true,
            createdAt: asDate(previous && previous.createdAt) || now,
            updatedAt: now,
            serverRevision: revision,
          }
          : {
            userID: normalizedUserID,
            id: mutation.wordID,
            written: mutation.written,
            spoken: mutation.spoken,
            isEnabled: mutation.isEnabled,
            deleted: false,
            createdAt: asDate(previous && previous.createdAt) || now,
            updatedAt: now,
            serverRevision: revision,
          };
        words.set(mutation.wordID, next);
        accepted.push(next);
      }

      const updatedAt = accepted.length > 0
        ? accepted[accepted.length - 1].updatedAt
        : (asDate(account.updatedAt) || new Date(this.now()));
      for (const word of accepted) {
        transaction.set(wordDocuments.get(word.id), word);
      }
      transaction.set(accountDocument, {
        userID: normalizedUserID,
        revision,
        wordCount,
        updatedAt,
      }, { merge: true });
      transaction.set(clientDocument, {
        userID: normalizedUserID,
        deviceID: normalizedDeviceID,
        lastSequence: acceptedThroughSequence,
        updatedAt,
      }, { merge: true });

      return {
        revision,
        acceptedThroughSequence,
        updatedAt,
      };
    });
  }

  get firestore() {
    return this.firestoreProvider();
  }

  collection(name) {
    return mojidasCollection(this.firestore, name);
  }

  accountDocument(userID) {
    return this.collection('dictionaryAccounts').doc(deterministicID(userID));
  }

  clientDocument(userID, deviceID) {
    return this.collection('dictionaryClients').doc(deterministicID(`${userID}:${deviceID}`));
  }

  wordDocument(userID, wordID) {
    return this.accountDocument(userID).collection('words').doc(wordID);
  }
}

function normalizeMutations(value) {
  if (!Array.isArray(value) || value.length > MAXIMUM_MUTATIONS_PER_REQUEST) {
    throw new DictionaryStoreError('INVALID_MUTATIONS', '単語辞書の更新内容が正しくありません。');
  }
  return value.map((mutation) => {
    const sequence = Number(mutation && mutation.sequence);
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      throw new DictionaryStoreError('INVALID_SEQUENCE', '単語辞書の更新順序が正しくありません。');
    }
    const wordID = normalizeUUID(mutation.wordID, 'INVALID_WORD_ID');
    const operation = mutation && mutation.operation;
    if (operation !== 'upsert' && operation !== 'delete') {
      throw new DictionaryStoreError('INVALID_OPERATION', '単語辞書の更新操作が正しくありません。');
    }
    if (operation === 'delete') return { sequence, wordID, operation };
    return {
      sequence,
      wordID,
      operation,
      ...normalizeWord(mutation),
    };
  }).sort((lhs, rhs) => lhs.sequence - rhs.sequence);
}

function normalizeWord(value) {
  const written = String(value && value.written || '').trim().normalize('NFC');
  const spoken = String(value && value.spoken || '').trim().normalize('NFC');
  if (!written || /[|"\\\r\n]/u.test(written)) {
    throw new DictionaryStoreError('INVALID_WORD', '書き表記を確認してください。');
  }
  if (!spoken || !/^[\u3041-\u309f\u30a0-\u30ff\uff66-\uff9f]+$/u.test(spoken)) {
    throw new DictionaryStoreError('INVALID_WORD', '読み表記を確認してください。');
  }
  return { written, spoken, isEnabled: value.isEnabled !== false };
}

function normalizeRequiredString(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new DictionaryStoreError(code, 'アカウント情報が正しくありません。');
  return normalized;
}

function normalizeUUID(value, code) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new DictionaryStoreError(code, '識別子が正しくありません。');
  }
  return normalized;
}

function normalizeRevision(value) {
  const revision = Number(value || 0);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new DictionaryStoreError('INVALID_REVISION', '単語辞書の更新位置が正しくありません。');
  }
  return revision;
}

function deterministicID(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function asDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function publicWord(word) {
  return {
    id: word.id,
    written: word.written || '',
    spoken: word.spoken || '',
    isEnabled: word.isEnabled !== false,
    deleted: Boolean(word.deleted),
    createdAt: asDate(word.createdAt),
    updatedAt: asDate(word.updatedAt),
    serverRevision: Number(word.serverRevision) || 0,
  };
}

const mojidasDictionaryStore = new MojidasDictionaryStore();

module.exports = mojidasDictionaryStore;
module.exports.DictionaryStoreError = DictionaryStoreError;
module.exports.MAXIMUM_MUTATIONS_PER_REQUEST = MAXIMUM_MUTATIONS_PER_REQUEST;
module.exports.MAXIMUM_WORD_COUNT = MAXIMUM_WORD_COUNT;
module.exports.MojidasDictionaryStore = MojidasDictionaryStore;
module.exports.normalizeMutations = normalizeMutations;
module.exports.normalizeRevision = normalizeRevision;
