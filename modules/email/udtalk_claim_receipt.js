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

module.exports = { claimReceiptMessage };
