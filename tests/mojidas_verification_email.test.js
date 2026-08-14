const assert = require('assert');

const { FirebaseAuthRestClient, FirebaseAuthError } = require('../modules/auth/firebase_auth_rest');
const { SendGridMailer } = require('../modules/email/sendgrid_mailer');
const { MojidasEmailVerificationService } = require('../modules/auth/mojidas_email_verification');
const {
  EmailVerificationStore,
  generateCode,
  hashCode,
  verifyCode,
} = require('../modules/auth/email_verification_store');
const {
  DEFAULT_FROM_EMAIL,
  MojidasVerificationEmailSender,
  escapeHTML,
} = require('../modules/auth/mojidas_verification_email');

async function main() {
  const outgoing = [];
  const mailer = {
    async send(message) {
      outgoing.push(message);
    },
  };
  const sender = new MojidasVerificationEmailSender({ mailer });
  await sender.send('user@example.com', '123456');

  assert.strictEqual(outgoing.length, 1);
  assert.strictEqual(outgoing[0].to, 'user@example.com');
  assert.match(outgoing[0].subject, /Mojidas/);
  assert.match(outgoing[0].text, /123456/);
  assert.match(outgoing[0].text, /10分/);
  assert.match(outgoing[0].html, /123456/);

  let request;
  const sendGridMailer = new SendGridMailer({
    apiKey: 'test-api-key',
    fromEmail: DEFAULT_FROM_EMAIL,
    fromName: 'Mojidas',
    requester: async (value) => {
      request = value;
    },
  });
  await sendGridMailer.send({
    to: 'user@example.com',
    subject: 'Subject',
    text: 'Text',
    html: '<p>HTML</p>',
    categories: ['mojidas-auth'],
  });

  assert.strictEqual(request.apiKey, 'test-api-key');
  assert.strictEqual(request.payload.from.email, 'no-reply@mojidas.jp');
  assert.strictEqual(request.payload.from.name, 'Mojidas');
  assert.strictEqual(request.payload.content[0].type, 'text/plain');
  assert.strictEqual(request.payload.content[1].type, 'text/html');
  assert.strictEqual(request.payload.tracking_settings.click_tracking.enable, false);
  assert.strictEqual(escapeHTML('a&"<>'), 'a&amp;&quot;&lt;&gt;');

  const verificationIssues = [];
  const authClient = new FirebaseAuthRestClient({
    apiKey: 'firebase-api-key',
    firebaseAdmin: { apps: [{}] },
    requester: async ({ path }) => {
      assert.match(path, /accounts:signUp/);
      return {
        localId: 'user-1',
        email: 'user@example.com',
        idToken: 'id-token',
        refreshToken: 'refresh-token',
        expiresIn: '3600',
      };
    },
    verificationService: {
      async issue(value) {
        verificationIssues.push(value);
      },
    },
  });
  const registered = await authClient.register('user@example.com', 'password123');
  assert.strictEqual(registered.id, 'user-1');
  assert.deepStrictEqual(verificationIssues, [{ uid: 'user-1', email: 'user@example.com' }]);

  const failingClient = new FirebaseAuthRestClient({
    apiKey: 'firebase-api-key',
    firebaseAdmin: { apps: [{}] },
    requester: async () => ({
      localId: 'user-2',
      email: 'failed@example.com',
      idToken: 'id-token',
    }),
    verificationService: {
      async issue() {
        throw new Error('SendGrid failure');
      },
    },
  });
  await assert.rejects(
    () => failingClient.register('failed@example.com', 'password123'),
    (error) => error instanceof FirebaseAuthError && error.code === 'VERIFICATION_EMAIL_FAILED'
  );

  const generatedCode = generateCode();
  assert.match(generatedCode, /^\d{6}$/);
  const codeHash = hashCode('654321');
  assert.strictEqual(verifyCode('654321', codeHash.salt, codeHash.hash), true);
  assert.strictEqual(verifyCode('654320', codeHash.salt, codeHash.hash), false);

  let now = Date.parse('2026-08-14T01:00:00Z');
  let storedChallenge = null;
  const challengeDocument = {
    async set(value) {
      storedChallenge = value;
    },
    async delete() {
      storedChallenge = null;
    },
  };
  const fakeFirestore = {
    collection(name) {
      assert.strictEqual(name, 'emailVerificationChallenges');
      return {
        doc(uid) {
          assert.strictEqual(uid, 'user-store');
          return challengeDocument;
        },
      };
    },
    async runTransaction(callback) {
      return callback({
        async get() {
          return {
            exists: Boolean(storedChallenge),
            data: () => storedChallenge,
          };
        },
        update(_document, values) {
          storedChallenge = { ...storedChallenge, ...values };
        },
        delete() {
          storedChallenge = null;
        },
      });
    },
  };
  const challengeStore = new EmailVerificationStore({
    firestoreProvider: () => fakeFirestore,
    now: () => now,
  });
  await challengeStore.saveChallenge({
    uid: 'user-store',
    email: 'store@example.com',
    code: '112233',
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(storedChallenge, 'code'), false);
  assert.strictEqual(typeof storedChallenge.codeHash, 'string');
  await assert.rejects(
    () => challengeStore.verifyChallenge({ uid: 'user-store', code: '000000' }),
    (error) => error.code === 'INVALID_VERIFICATION_CODE'
  );
  assert.strictEqual(storedChallenge.attempts, 1);
  assert.strictEqual(
    await challengeStore.verifyChallenge({ uid: 'user-store', code: '112233' }),
    true
  );
  now += 10 * 60 * 1000;
  await assert.rejects(
    () => challengeStore.verifyChallenge({ uid: 'user-store', code: '112233' }),
    (error) => error.code === 'EXPIRED_VERIFICATION_CODE'
  );
  assert.strictEqual(storedChallenge, null);

  const storeCalls = [];
  const serviceEmails = [];
  const verificationService = new MojidasEmailVerificationService({
    firebaseAdmin: {
      auth() {
        return {
          async getUserByEmail(email) {
            assert.strictEqual(email, 'user@example.com');
            return { uid: 'user-1', email, emailVerified: false };
          },
          async updateUser(uid, attributes) {
            storeCalls.push(['update-user', uid, attributes]);
            return { uid, email: 'user@example.com', emailVerified: true };
          },
        };
      },
    },
    store: {
      async saveChallenge(value) {
        storeCalls.push(['save', value]);
        return { expiresAt: new Date('2026-08-14T01:10:00Z') };
      },
      async verifyChallenge(value) {
        storeCalls.push(['verify', value]);
      },
      async deleteChallenge(uid) {
        storeCalls.push(['delete', uid]);
      },
    },
    emailSender: {
      async send(email, code) {
        serviceEmails.push({ email, code });
      },
    },
  });
  await verificationService.issue({ uid: 'user-1', email: 'user@example.com' });
  assert.strictEqual(serviceEmails[0].email, 'user@example.com');
  assert.match(serviceEmails[0].code, /^\d{6}$/);
  await verificationService.verify({ email: 'user@example.com', code: serviceEmails[0].code });
  assert.deepStrictEqual(storeCalls[1], [
    'verify',
    { uid: 'user-1', code: serviceEmails[0].code },
  ]);
  assert.deepStrictEqual(storeCalls[2], [
    'update-user',
    'user-1',
    { emailVerified: true },
  ]);
  assert.deepStrictEqual(storeCalls[3], ['delete', 'user-1']);

  console.log('Mojidas確認コード: 34件のテストに成功しました。');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
