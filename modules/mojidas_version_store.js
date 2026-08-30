const { getFirestore } = require('./firestore');
const { mojidasCollection } = require('./mojidas_firestore');

const DEFAULT_MACOS_VERSION = '0.8.0';
const DEFAULT_WINDOWS_VERSION = '0.11.0.0';
const VERSION_DOCUMENT_ID = 'appVersions';

class MojidasVersionStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MojidasVersionStoreError';
    this.code = code;
  }
}

class MojidasVersionStore {
  constructor({ firestoreProvider = getFirestore, now = () => new Date() } = {}) {
    this.firestoreProvider = firestoreProvider;
    this.now = now;
  }

  async getVersions() {
    const snapshot = await this.document.get();
    const data = snapshot.exists ? snapshot.data() : {};

    return {
      schemaVersion: 1,
      macOSVersion: normalizeStoredVersion(
        data.macOSVersion,
        3,
        DEFAULT_MACOS_VERSION
      ),
      windowsVersion: normalizeStoredVersion(
        data.windowsVersion,
        4,
        DEFAULT_WINDOWS_VERSION
      ),
      updatedAt: asDate(data.updatedAt),
    };
  }

  async setVersions({ macOSVersion, windowsVersion }) {
    const normalizedMacOSVersion = normalizeVersion(macOSVersion, 3, 'Mac版');
    const normalizedWindowsVersion = normalizeVersion(windowsVersion, 4, 'Windows版');
    const updatedAt = this.now();

    await this.document.set({
      macOSVersion: normalizedMacOSVersion,
      windowsVersion: normalizedWindowsVersion,
      updatedAt,
    });

    return {
      schemaVersion: 1,
      macOSVersion: normalizedMacOSVersion,
      windowsVersion: normalizedWindowsVersion,
      updatedAt,
    };
  }

  get firestore() {
    return this.firestoreProvider();
  }

  get document() {
    return mojidasCollection(this.firestore, 'configuration').doc(VERSION_DOCUMENT_ID);
  }
}

function normalizeVersion(value, componentCount, label = 'バージョン') {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const components = normalized.split('.');
  const maximumComponent = componentCount === 4 ? 65_535 : 2_147_483_647;
  if (
    normalized.length > 64
    || components.length !== componentCount
    || components.some((component) => {
      if (!/^(0|[1-9]\d*)$/.test(component)) return true;
      const number = Number(component);
      return !Number.isSafeInteger(number) || number > maximumComponent;
    })
  ) {
    const example = componentCount === 3 ? '0.0.0' : '0.0.0.0';
    throw new MojidasVersionStoreError(
      'INVALID_VERSION',
      `${label}バージョンは${example}形式で入力してください。`
    );
  }
  return normalized;
}

function normalizeStoredVersion(value, componentCount, fallback) {
  try {
    return normalizeVersion(value, componentCount);
  } catch (error) {
    return fallback;
  }
}

function asDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

module.exports = new MojidasVersionStore();
module.exports.DEFAULT_MACOS_VERSION = DEFAULT_MACOS_VERSION;
module.exports.DEFAULT_WINDOWS_VERSION = DEFAULT_WINDOWS_VERSION;
module.exports.MojidasVersionStore = MojidasVersionStore;
module.exports.MojidasVersionStoreError = MojidasVersionStoreError;
module.exports.normalizeVersion = normalizeVersion;
