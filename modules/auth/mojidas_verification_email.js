const { SendGridMailer } = require('../email/sendgrid_mailer');

const DEFAULT_FROM_EMAIL = 'no-reply@mojidas.jp';
const DEFAULT_FROM_NAME = 'Mojidas';

class MojidasVerificationEmailSender {
  constructor({ mailer } = {}) {
    this.mailer = mailer || new SendGridMailer({
      fromEmail: process.env.MOJIDAS_AUTH_FROM_EMAIL || DEFAULT_FROM_EMAIL,
      fromName: DEFAULT_FROM_NAME,
    });
  }

  async send(email, code) {
    const safeCode = escapeHTML(code);
    await this.mailer.send({
      to: email,
      subject: 'Mojidas メールアドレスの確認',
      text: [
        'Mojidasアカウントをご登録いただきありがとうございます。',
        '',
        'Mojidasアプリに次の6桁の認証コードを入力してください。',
        '',
        code,
        '',
        '認証コードの有効時間は10分です。',
        '',
        'このメールに心当たりがない場合は、そのまま破棄してください。',
      ].join('\n'),
      html: [
        '<p>Mojidasアカウントをご登録いただきありがとうございます。</p>',
        '<p>Mojidasアプリに次の6桁の認証コードを入力してください。</p>',
        `<p style="margin:24px 0;padding:16px;background:#f3f1ff;border-radius:10px;color:#2d218c;font-size:30px;font-weight:700;letter-spacing:8px;text-align:center">${safeCode}</p>`,
        '<p style="font-size:12px;color:#666">認証コードの有効時間は10分です。</p>',
        '<p style="font-size:12px;color:#666">このメールに心当たりがない場合は、そのまま破棄してください。</p>',
      ].join(''),
      categories: ['mojidas-auth'],
    });
  }
}

function escapeHTML(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = {
  DEFAULT_FROM_EMAIL,
  MojidasVerificationEmailSender,
  escapeHTML,
};
