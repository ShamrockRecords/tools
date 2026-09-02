const assert = require('assert');

const {
  MemoryFormalTranslationJobStore,
} = require('../modules/translation/formal_translation_job_store');

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  let operations = 0;
  const store = new MemoryFormalTranslationJobStore();
  const first = store.start({
    userID: 'user-1',
    idempotencyKey: 'key-1',
    requestFingerprint: 'fingerprint-1',
    operation: async () => {
      operations += 1;
      return { blocks: [{ translatedText: 'Hello' }] };
    },
  });
  assert.strictEqual(first.status, 'processing');
  await settle();
  const completed = store.get({ jobID: first.jobID, userID: 'user-1' });
  assert.strictEqual(completed.status, 'completed');
  assert.strictEqual(completed.result.blocks[0].translatedText, 'Hello');

  const duplicate = store.start({
    userID: 'user-1',
    idempotencyKey: 'key-1',
    requestFingerprint: 'fingerprint-1',
    operation: async () => {
      operations += 1;
      return {};
    },
  });
  assert.strictEqual(duplicate.jobID, first.jobID);
  assert.strictEqual(duplicate.status, 'completed');
  assert.strictEqual(operations, 1);
  assert.strictEqual(store.get({ jobID: first.jobID, userID: 'user-2' }), null);

  assert.throws(() => store.start({
    userID: 'user-1',
    idempotencyKey: 'key-1',
    requestFingerprint: 'different',
    operation: async () => ({}),
  }), (error) => error.code === 'IDEMPOTENCY_CONFLICT');

  const failed = store.start({
    userID: 'user-1',
    idempotencyKey: 'key-2',
    requestFingerprint: 'fingerprint-2',
    operation: async () => {
      const error = new Error('failed');
      error.code = 'OPENAI_TIMEOUT';
      throw error;
    },
  });
  await settle();
  const failedResult = store.get({ jobID: failed.jobID, userID: 'user-1' });
  assert.strictEqual(failedResult.status, 'failed');
  assert.strictEqual(failedResult.error.code, 'OPENAI_TIMEOUT');

  const timedOutStore = new MemoryFormalTranslationJobStore({
    operationTimeoutMilliseconds: 10,
  });
  let timedOutSignal;
  const timedOut = timedOutStore.start({
    userID: 'user-1',
    idempotencyKey: 'key-timeout',
    requestFingerprint: 'fingerprint-timeout',
    operation: async (signal) => {
      timedOutSignal = signal;
      return new Promise(() => {});
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const timedOutResult = timedOutStore.get({
    jobID: timedOut.jobID,
    userID: 'user-1',
  });
  assert.strictEqual(timedOutResult.status, 'failed');
  assert.strictEqual(timedOutResult.error.code, 'TRANSLATION_JOB_TIMEOUT');
  assert.strictEqual(timedOutSignal.aborted, true);
}

main()
  .then(() => console.log('Formal translation job store tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
