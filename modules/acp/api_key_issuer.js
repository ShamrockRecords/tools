const https = require('https');

const DEFAULT_ENDPOINT = 'https://acp-api.amivoice.com/issue_service_authorization';
const DEFAULT_EXPIRY_MILLISECONDS = 120000;
const MEDIA_ASYNC_EXPIRY_MILLISECONDS = 10 * 60 * 1000;
const MIN_EXPIRY_MILLISECONDS = 30000;
const MAX_EXPIRY_MILLISECONDS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MILLISECONDS = 10000;
const MAX_RESPONSE_BYTES = 16 * 1024;

class ACPApiKeyIssuerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ACPApiKeyIssuerError';
    this.code = code;
  }
}

class ACPApiKeyIssuer {
  constructor({
    serviceID = process.env.ACP_SERVICE_ID,
    servicePassword = process.env.ACP_SERVICE_PASSWORD,
    endpoint = process.env.ACP_API_KEY_ISSUER_URL || DEFAULT_ENDPOINT,
    expiryMilliseconds = process.env.ACP_API_KEY_EXPIRY_MS || DEFAULT_EXPIRY_MILLISECONDS,
    request = postForm,
    now = () => Date.now(),
  } = {}) {
    this.serviceID = normalizeSecret(serviceID);
    this.servicePassword = normalizeSecret(servicePassword);
    this.endpoint = endpoint;
    this.expiryMilliseconds = normalizeExpiry(expiryMilliseconds);
    this.request = request;
    this.now = now;
  }

  async issue({ expiryMilliseconds = this.expiryMilliseconds } = {}) {
    if (!this.serviceID || !this.servicePassword) {
      throw new ACPApiKeyIssuerError(
        'ACP_NOT_CONFIGURED',
        'ACPのAPIキー発行設定が完了していません。'
      );
    }

    const normalizedExpiryMilliseconds = normalizeExpiry(expiryMilliseconds);
    const body = new URLSearchParams({
      sid: this.serviceID,
      spw: this.servicePassword,
      epi: String(normalizedExpiryMilliseconds),
    }).toString();
    const rawKey = await this.request(this.endpoint, body);
    const appKey = String(rawKey || '').trim();

    // ACPは成功時にプレーンテキストのキーを返す。HTMLや改行を含む応答は転送しない。
    if (appKey.length < 32 || appKey.length > 4096 || /\s|[<>]/.test(appKey)) {
      throw new ACPApiKeyIssuerError(
        'ACP_INVALID_RESPONSE',
        'ACPから有効なAPIキーを取得できませんでした。'
      );
    }

    return {
      appKey,
      expiresAt: new Date(this.now() + normalizedExpiryMilliseconds).toISOString(),
    };
  }
}

function normalizeSecret(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeExpiry(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_EXPIRY_MILLISECONDS;
  }
  return Math.min(
    MAX_EXPIRY_MILLISECONDS,
    Math.max(MIN_EXPIRY_MILLISECONDS, Math.floor(parsed))
  );
}

function postForm(endpoint, body) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = https.request(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'text/plain',
      },
    }, (response) => {
      let responseBody = '';
      let responseBytes = 0;
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > MAX_RESPONSE_BYTES) {
          response.destroy();
          fail(new ACPApiKeyIssuerError(
            'ACP_INVALID_RESPONSE',
            'ACPからの応答サイズが上限を超えました。'
          ));
          return;
        }
        responseBody += chunk;
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new ACPApiKeyIssuerError(
            'ACP_REQUEST_FAILED',
            'ACPのAPIキー発行サービスへ接続できませんでした。'
          ));
          return;
        }
        resolve(responseBody);
      });
      response.on('error', fail);
    });

    request.setTimeout(REQUEST_TIMEOUT_MILLISECONDS, () => {
      request.destroy();
      fail(new ACPApiKeyIssuerError(
        'ACP_TIMEOUT',
        'ACPのAPIキー発行サービスがタイムアウトしました。'
      ));
    });
    request.on('error', (error) => {
      fail(error instanceof ACPApiKeyIssuerError
        ? error
        : new ACPApiKeyIssuerError('ACP_REQUEST_FAILED', 'ACPへ接続できませんでした。'));
    });
    request.write(body);
    request.end();
  });
}

module.exports = {
  ACPApiKeyIssuer,
  ACPApiKeyIssuerError,
  DEFAULT_EXPIRY_MILLISECONDS,
  MEDIA_ASYNC_EXPIRY_MILLISECONDS,
  normalizeExpiry,
};
