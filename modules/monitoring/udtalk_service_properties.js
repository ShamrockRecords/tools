const https = require('https');
const { TextDecoder } = require('util');
const { SendGridMailer } = require('../email/sendgrid_mailer');

const SERVICE_URL = 'https://service.udtalk.jp/api/properties/udtalk/service_v3.php';
const ALERT_EMAIL = 'info@shamrock-records.jp';
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

class ServicePropertiesError extends Error {
  constructor(code, message, result) {
    super(message);
    this.name = 'ServicePropertiesError';
    this.code = code;
    this.result = result;
  }
}

function fetchServiceProperties({
  request = https.request,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let response;
    const finish = (error, body) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (response) response.destroy();
        if (req) req.destroy();
        reject(error);
      } else {
        resolve(body);
      }
    };
    // 接続・DNS・本文の受信を含めた全体に期限を設ける。
    const timer = setTimeout(() => finish(new ServicePropertiesError(
      'FETCH_TIMEOUT', '設定JSONの取得が10秒以内に完了しませんでした。'
    )), timeoutMs);
    const connectionError = () => finish(new ServicePropertiesError(
      'FETCH_FAILED', '設定JSONを取得できませんでした。通信障害または接続の中断です。'
    ));

    try {
      req = request(SERVICE_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache, no-store',
          Pragma: 'no-cache',
        },
      }, (res) => {
        response = res;
        res.on('error', connectionError);
        res.on('aborted', connectionError);
        if (settled) {
          res.destroy();
          return;
        }
        if (res.statusCode !== 200) {
          finish(new ServicePropertiesError(
            'HTTP_ERROR', `設定JSONの取得でHTTP ${res.statusCode}が返されました。`
          ));
          return;
        }
        const chunks = [];
        let bytes = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > maxBytes) {
            finish(new ServicePropertiesError(
              'RESPONSE_TOO_LARGE', '設定JSONのレスポンスがサイズ上限（1 MiB）を超えています。'
            ));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (!res.complete) return connectionError();
          finish(null, Buffer.concat(chunks));
        });
      });
      req.on('error', connectionError);
      req.end();
    } catch (_error) {
      connectionError();
    }
  });
}

function validateServiceProperties(body) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (_error) {
    throw new ServicePropertiesError('INVALID_ENCODING', 'レスポンスが正しいUTF-8ではありません。');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    // JSON.parseのメッセージには設定値が混入するため、位置だけを取り出す。
    const position = /position (\d+)/.exec(error.message);
    let location = '';
    if (position) {
      const before = text.slice(0, Number(position[1]));
      location = `（${before.split('\n').length}行、${before.length - before.lastIndexOf('\n')}列付近）`;
    }
    throw new ServicePropertiesError(
      'INVALID_JSON', `JSONの構文が正しくありません${location}。カンマ、引用符、括弧、空のレスポンスなどを確認してください。`
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) {
    throw new ServicePropertiesError(
      'INVALID_STRUCTURE', '設定JSONは1件以上の項目を持つオブジェクトである必要があります。'
    );
  }
}

function configuredMailer() {
  const mailer = new SendGridMailer({ fromName: 'UDトーク 設定監視' });
  if (!mailer.apiKey || !mailer.fromEmail) {
    throw new ServicePropertiesError(
      'MONITOR_NOT_CONFIGURED', 'SENDGRID_API_KEYとSENDGRID_FROM_EMAILを設定してください。'
    );
  }
  return mailer;
}

class ServicePropertiesMonitor {
  constructor({ fetcher = fetchServiceProperties, mailer, now = () => new Date() } = {}) {
    this.fetcher = fetcher;
    this.mailer = mailer;
    this.now = now;
  }

  async check({ notify = true } = {}) {
    // 正常時も通知設定の欠落を検出する。dry-runでは送信設定を不要とする。
    const mailer = notify ? (this.mailer || configuredMailer()) : null;
    const result = {
      ok: true,
      url: SERVICE_URL,
      checkedAt: this.now().toISOString(),
      notification: 'not_needed',
    };
    try {
      validateServiceProperties(await this.fetcher());
    } catch (error) {
      result.ok = false;
      result.error = error instanceof ServicePropertiesError
        ? { code: error.code, message: error.message }
        : { code: 'FETCH_FAILED', message: '設定JSONの取得または検証に失敗しました。' };
    }
    if (result.ok) return result;
    if (!notify) return { ...result, notification: 'skipped' };

    try {
      // 状態を保存・抑制しないため、異常が続く限り毎回通知し、復旧すれば停止する。
      await mailer.send({
        to: ALERT_EMAIL,
        subject: '[UDトーク] service_v3.php のJSON異常を検出しました',
        text: [
          'UDトークの設定JSONの検査で異常を検出しました。',
          '',
          `対象URL: ${SERVICE_URL}`,
          `検査日時（UTC）: ${result.checkedAt}`,
          `エラー: ${result.error.code}`,
          `内容: ${result.error.message}`,
          '',
          '設定ファイルの編集内容と、サーバーの応答を確認してください。',
          '異常が続く間はスケジューラーによる検査のたびに通知します。正常に戻ると通知は停止します。',
        ].join('\n'),
        categories: ['udtalk-service-properties-monitor'],
      });
    } catch (_error) {
      throw new ServicePropertiesError(
        'ALERT_EMAIL_FAILED', '異常を検出しましたが、通知メールの送信に失敗しました。SendGridの設定と稼働状況を確認してください。',
        { ...result, notification: 'failed' }
      );
    }
    return { ...result, notification: 'accepted' };
  }
}

function publicError(error) {
  return error instanceof ServicePropertiesError
    ? { code: error.code, message: error.message }
    : { code: 'MONITOR_FAILED', message: '設定JSONの監視処理に失敗しました。' };
}

module.exports = {
  SERVICE_URL,
  ALERT_EMAIL,
  ServicePropertiesError,
  ServicePropertiesMonitor,
  fetchServiceProperties,
  validateServiceProperties,
  publicError,
};
