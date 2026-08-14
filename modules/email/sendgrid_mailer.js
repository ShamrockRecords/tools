const https = require('https');

const SENDGRID_HOST = 'api.sendgrid.com';
const SENDGRID_PATH = '/v3/mail/send';
const REQUEST_TIMEOUT_MILLISECONDS = 10000;
const MAX_RESPONSE_BYTES = 64 * 1024;

class SendGridMailerError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = 'SendGridMailerError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

class SendGridMailer {
  constructor({
    apiKey = process.env.SENDGRID_API_KEY,
    fromEmail = process.env.SENDGRID_FROM_EMAIL,
    fromName,
    requester = sendGridRequest,
  } = {}) {
    this.apiKey = normalize(apiKey);
    this.fromEmail = normalize(fromEmail);
    this.fromName = normalize(fromName);
    this.requester = requester;
  }

  async send({ to, subject, text, html, categories = [] }) {
    if (!this.apiKey || !this.fromEmail) {
      throw new SendGridMailerError(
        'SENDGRID_NOT_CONFIGURED',
        'メール送信サービスの設定が完了していません。'
      );
    }

    const recipient = normalize(to);
    const normalizedSubject = normalize(subject);
    if (!recipient || !normalizedSubject || (!text && !html)) {
      throw new SendGridMailerError('INVALID_EMAIL_MESSAGE', 'メールの内容が正しくありません。');
    }

    const content = [];
    if (text) content.push({ type: 'text/plain', value: String(text) });
    if (html) content.push({ type: 'text/html', value: String(html) });
    const from = { email: this.fromEmail };
    if (this.fromName) from.name = this.fromName;

    const payload = {
      personalizations: [{ to: [{ email: recipient }] }],
      from,
      subject: normalizedSubject,
      content,
      categories: categories.slice(0, 10),
      tracking_settings: {
        click_tracking: { enable: false, enable_text: false },
        open_tracking: { enable: false },
      },
    };

    await this.requester({ apiKey: this.apiKey, payload });
  }
}

function normalize(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sendGridRequest({ apiKey, payload }) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishWithError = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = https.request({
      hostname: SENDGRID_HOST,
      path: SENDGRID_PATH,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      let responseBytes = 0;
      response.on('data', (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > MAX_RESPONSE_BYTES) response.destroy();
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
          return;
        }
        reject(new SendGridMailerError(
          'SENDGRID_REQUEST_FAILED',
          '確認メールを送信できませんでした。',
          response.statusCode
        ));
      });
      response.on('error', () => finishWithError(new SendGridMailerError(
        'SENDGRID_REQUEST_FAILED',
        '確認メールを送信できませんでした。'
      )));
    });

    request.setTimeout(REQUEST_TIMEOUT_MILLISECONDS, () => {
      request.destroy();
      finishWithError(new SendGridMailerError(
        'SENDGRID_TIMEOUT',
        '確認メールの送信がタイムアウトしました。'
      ));
    });
    request.on('error', () => finishWithError(new SendGridMailerError(
      'SENDGRID_REQUEST_FAILED',
      '確認メールを送信できませんでした。'
    )));
    request.write(body);
    request.end();
  });
}

module.exports = {
  SendGridMailer,
  SendGridMailerError,
  sendGridRequest,
};
