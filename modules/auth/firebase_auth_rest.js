const https = require('https');
const { MojidasVerificationEmailSender } = require('./mojidas_verification_email');

const REQUEST_TIMEOUT_MS = 10 * 1000;

class FirebaseAuthError extends Error {
  constructor(code, message, statusCode) {
    super(message || code);
    this.name = 'FirebaseAuthError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeFirebaseError(payload, statusCode) {
  const rawMessage = payload && payload.error && payload.error.message
    ? payload.error.message
    : 'FIREBASE_AUTH_ERROR';
  const code = String(rawMessage).split(' : ')[0].trim();
  return new FirebaseAuthError(code, rawMessage, statusCode);
}

function request({ hostname, path, contentType, body }) {
  const payload = Buffer.from(body, 'utf8');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': payload.length,
      },
    }, (response) => {
      let responseBody = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBody += chunk;
      });
      response.on('end', () => {
        let data = {};

        try {
          data = responseBody ? JSON.parse(responseBody) : {};
        } catch (error) {
          return reject(new FirebaseAuthError(
            'INVALID_FIREBASE_RESPONSE',
            'Firebase Authenticationから不正な応答を受信しました。',
            response.statusCode
          ));
        }

        if (response.statusCode >= 200 && response.statusCode < 300) {
          return resolve(data);
        }

        return reject(normalizeFirebaseError(data, response.statusCode));
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new FirebaseAuthError(
        'FIREBASE_TIMEOUT',
        'Firebase Authenticationへの接続がタイムアウトしました。',
        504
      ));
    });
    req.on('error', (error) => reject(error));
    req.write(payload);
    req.end();
  });
}

class FirebaseAuthRestClient {
  constructor({ apiKey, firebaseAdmin, requester = request, verificationEmailSender }) {
    this.apiKey = apiKey;
    this.firebaseAdmin = firebaseAdmin;
    this.requester = requester;
    this.verificationEmailSender = verificationEmailSender
      || new MojidasVerificationEmailSender({ firebaseAdmin });
  }

  ensureConfigured() {
    if (!this.apiKey || !this.firebaseAdmin || !this.firebaseAdmin.apps.length) {
      throw new FirebaseAuthError(
        'AUTH_NOT_CONFIGURED',
        '認証サーバーの設定が完了していません。',
        503
      );
    }
  }

  async register(email, password) {
    this.ensureConfigured();
    const response = await this.identityRequest('accounts:signUp', {
      email,
      password,
      returnSecureToken: true,
    });

    try {
      await this.verificationEmailSender.send(response.email || email);
    } catch (error) {
      throw new FirebaseAuthError(
        'VERIFICATION_EMAIL_FAILED',
        'アカウントは作成されましたが、確認メールを送信できませんでした。',
        502
      );
    }

    return {
      id: response.localId,
      email: response.email,
      emailVerified: false,
    };
  }

  async login(email, password) {
    this.ensureConfigured();
    const response = await this.identityRequest('accounts:signInWithPassword', {
      email,
      password,
      returnSecureToken: true,
    });
    const user = await this.firebaseAdmin.auth().getUser(response.localId);

    if (!user.emailVerified) {
      try {
        await this.verificationEmailSender.send(response.email || email);
      } catch (error) {
        // ログイン拒否を優先し、確認メール再送の失敗は外へ漏らさない。
      }
      throw new FirebaseAuthError(
        'EMAIL_NOT_VERIFIED',
        'メールアドレスの確認が完了していません。',
        403
      );
    }

    return this.tokenResponse(response, user);
  }

  async refresh(refreshToken) {
    this.ensureConfigured();
    const response = await this.requester({
      hostname: 'securetoken.googleapis.com',
      path: `/v1/token?key=${encodeURIComponent(this.apiKey)}`,
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
    });
    const decoded = await this.firebaseAdmin.auth().verifyIdToken(response.id_token, true);
    const user = await this.firebaseAdmin.auth().getUser(decoded.uid);

    if (!user.emailVerified) {
      throw new FirebaseAuthError(
        'EMAIL_NOT_VERIFIED',
        'メールアドレスの確認が完了していません。',
        403
      );
    }

    return {
      accessToken: response.id_token,
      refreshToken: response.refresh_token,
      expiresIn: Number(response.expires_in),
      user: this.publicUser(user),
    };
  }

  async sendPasswordReset(email) {
    this.ensureConfigured();
    await this.identityRequest('accounts:sendOobCode', {
      requestType: 'PASSWORD_RESET',
      email,
    });
  }

  async verifyAccessToken(idToken) {
    this.ensureConfigured();
    const decoded = await this.firebaseAdmin.auth().verifyIdToken(idToken, true);
    const user = await this.firebaseAdmin.auth().getUser(decoded.uid);

    if (!user.emailVerified) {
      throw new FirebaseAuthError(
        'EMAIL_NOT_VERIFIED',
        'メールアドレスの確認が完了していません。',
        403
      );
    }

    return user;
  }

  async identityRequest(method, payload) {
    return this.requester({
      hostname: 'identitytoolkit.googleapis.com',
      path: `/v1/${method}?key=${encodeURIComponent(this.apiKey)}`,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  }

  tokenResponse(response, user) {
    return {
      accessToken: response.idToken,
      refreshToken: response.refreshToken,
      expiresIn: Number(response.expiresIn),
      user: this.publicUser(user),
    };
  }

  publicUser(user) {
    return {
      id: user.uid,
      email: user.email,
      emailVerified: Boolean(user.emailVerified),
    };
  }
}

module.exports = {
  FirebaseAuthError,
  FirebaseAuthRestClient,
  normalizeFirebaseError,
  request,
};
