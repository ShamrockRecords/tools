class ACPApiKeyIssuerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ACPApiKeyIssuerError';
    this.code = code;
  }
}

class ACPApiKeyIssuer {
  constructor({ longTermAppKey = process.env.ACP_LONG_TERM_APPKEY } = {}) {
    this.longTermAppKey = typeof longTermAppKey === 'string' ? longTermAppKey.trim() : '';
  }

  async issue() {
    if (!this.longTermAppKey) {
      throw new ACPApiKeyIssuerError('ACP_NOT_CONFIGURED', 'ACP_LONG_TERM_APPKEYが設定されていません。');
    }
    if (this.longTermAppKey.length < 32 || this.longTermAppKey.length > 4096
        || /\s|[<>]/.test(this.longTermAppKey)) {
      throw new ACPApiKeyIssuerError('ACP_NOT_CONFIGURED', 'ACPの長期APIキー設定が不正です。');
    }
    // 旧アプリと同じJSON形式。短期発行や外部通信は行わない。
    return { appKey: this.longTermAppKey, expiresAt: null };
  }
}

module.exports = { ACPApiKeyIssuer, ACPApiKeyIssuerError };
