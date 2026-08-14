const { SendGridMailer } = require('../email/sendgrid_mailer');

const DEFAULT_FROM_EMAIL = 'no-reply@mojidas.jp';
const DEFAULT_FROM_NAME = 'Mojidas';

class MojidasVerificationEmailSender {
  constructor({ firebaseAdmin, mailer } = {}) {
    this.firebaseAdmin = firebaseAdmin;
    this.mailer = mailer || new SendGridMailer({
      fromEmail: process.env.MOJIDAS_AUTH_FROM_EMAIL || DEFAULT_FROM_EMAIL,
      fromName: DEFAULT_FROM_NAME,
    });
  }

  async send(email) {
    const link = await this.firebaseAdmin.auth().generateEmailVerificationLink(email);
    const escapedLink = escapeHTML(link);
    await this.mailer.send({
      to: email,
      subject: 'Mojidas メールアドレスの確認',
      text: [
        'Mojidasアカウントをご登録いただきありがとうございます。',
        '',
        '次のリンクを開いてメールアドレスを確認してください。',
        link,
        '',
        'このメールに心当たりがない場合は、そのまま破棄してください。',
      ].join('\n'),
      html: [
        '<p>Mojidasアカウントをご登録いただきありがとうございます。</p>',
        '<p>次のボタンを押してメールアドレスを確認してください。</p>',
        `<p><a href="${escapedLink}" style="display:inline-block;padding:12px 20px;background:#3925a8;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">メールアドレスを確認</a></p>`,
        `<p style="font-size:12px;color:#666;word-break:break-all">ボタンを開けない場合：<br>${escapedLink}</p>`,
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
