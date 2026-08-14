const assert = require('assert');

const { FirebaseAuthRestClient, FirebaseAuthError } = require('../modules/auth/firebase_auth_rest');
const { SendGridMailer } = require('../modules/email/sendgrid_mailer');
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
  const firebaseAdmin = {
    auth() {
      return {
        async generateEmailVerificationLink(email) {
          assert.strictEqual(email, 'user@example.com');
          return 'https://example.test/verify?mode=verifyEmail&oobCode=a&continueUrl=x&y=1';
        },
      };
    },
  };
  const sender = new MojidasVerificationEmailSender({ firebaseAdmin, mailer });
  await sender.send('user@example.com');

  assert.strictEqual(outgoing.length, 1);
  assert.strictEqual(outgoing[0].to, 'user@example.com');
  assert.match(outgoing[0].subject, /Mojidas/);
  assert.match(outgoing[0].text, /https:\/\/example\.test\/verify/);
  assert.match(outgoing[0].html, /&amp;y=1/);

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

  const verificationRecipients = [];
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
    verificationEmailSender: {
      async send(email) {
        verificationRecipients.push(email);
      },
    },
  });
  const registered = await authClient.register('user@example.com', 'password123');
  assert.strictEqual(registered.id, 'user-1');
  assert.deepStrictEqual(verificationRecipients, ['user@example.com']);

  const failingClient = new FirebaseAuthRestClient({
    apiKey: 'firebase-api-key',
    firebaseAdmin: { apps: [{}] },
    requester: async () => ({
      localId: 'user-2',
      email: 'failed@example.com',
      idToken: 'id-token',
    }),
    verificationEmailSender: {
      async send() {
        throw new Error('SendGrid failure');
      },
    },
  });
  await assert.rejects(
    () => failingClient.register('failed@example.com', 'password123'),
    (error) => error instanceof FirebaseAuthError && error.code === 'VERIFICATION_EMAIL_FAILED'
  );

  console.log('Mojidas確認メール: 16件のテストに成功しました。');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
