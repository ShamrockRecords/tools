function claimReceiptMessage({ id, accountName, email }) {
  return {
    to: email,
    subject: '【UDトーク】単語登録アカウント所持申請を受け付けました',
    text: [
      'UDトークをご利用いただき、ありがとうございます。',
      '単語登録アカウント所持申請を受け付けました。',
      '',
      '申請内容の確認には、2〜3日ほどお時間をいただきます。',
      'あらかじめご了承くださいますようお願いいたします。',
      '',
      '内容の確認後、メールアドレスの紐づけ対応を進めます。',
      'このメールは申請受付のお知らせです。メールアドレスの設定完了をお知らせするものではありません。',
      '',
      `単語登録アカウント名：${accountName}`,
      `受付番号：${id}`,
      '',
      'UDトーク',
    ].join('\n'),
    categories: ['udtalk-word-account-claim-receipt'],
  };
}

function claimAdminMessage({ id, accountName, email }, adminEmail) {
  const rootURL = (process.env.ROOT_URL || 'http://localhost:3000').replace(/\/$/, '');
  return {
    to: adminEmail,
    subject: '【UDトーク】単語登録アカウント復活申請が届きました',
    text: [
      '単語登録アカウントの復活申請が届きました。',
      '',
      `単語登録アカウント名：${accountName}`,
      `申請者メールアドレス：${email}`,
      `受付番号：${id}`,
      '',
      '管理画面で申請内容をご確認ください。',
      `${rootURL}/admin/udtalk-word-account-claims`,
    ].join('\n'),
    categories: ['udtalk-word-account-claim-admin'],
  };
}

function claimRecoveryMessage(email) {
  return {
    to: email,
    subject: '【UDトーク】単語登録アカウントの復旧が完了しました',
    text: [
      'UDトークをご利用いただき、ありがとうございます。',
      '',
      '申請いただいた単語登録アカウントにメールアドレスを設定し、復旧が完了しました。',
      '',
      'ご利用を再開するには、単語登録アカウントのログイン画面にある「パスワードを忘れてしまった方は」から、ご自身でパスワードの再設定をお願いいたします。その際は、申請時のメールアドレスをご入力ください。',
      '',
      'UDトーク',
    ].join('\n'),
    categories: ['udtalk-word-account-claim-recovery'],
  };
}

module.exports = { claimReceiptMessage, claimAdminMessage, claimRecoveryMessage };
