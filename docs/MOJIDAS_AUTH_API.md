# Mojidas 認証API

## 概要

macOS / Windows版Mojidasから利用する、メールアドレス＋パスワード認証のJSON APIです。Firebase Authenticationを認証基盤として使い、デスクトップアプリはFirebase IDトークンをBearerトークンとして送信します。

- Base path: `/api/mojidas`
- 本番URL: `https://app.mojidas.jp/api/mojidas`
- Content-Type: `application/json`
- 本番環境ではHTTPS必須
- メール確認が完了するまでログイン不可
- IDトークンの有効期間はFirebase応答の `expiresIn` を参照
- 更新トークンはOSの資格情報ストア（macOS Keychain / Windows DPAPI）へ保存
- `app.mojidas.jp`以外の公開ホストでは404を返す（ローカル開発用の`localhost`、`127.0.0.1`、`::1`を除く）

## エンドポイント

### `POST /api/mojidas/auth/register`

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

- パスワードは8〜128文字。
- 成功時はFirebaseの確認メールを送信します。

```json
{
  "user": {
    "id": "firebase-uid",
    "email": "user@example.com",
    "emailVerified": false
  },
  "verificationRequired": true
}
```

### `POST /api/mojidas/auth/login`

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

確認済みメールだけ成功します。未確認の場合は確認メールを再送し、`EMAIL_NOT_VERIFIED`を返します。

```json
{
  "accessToken": "Firebase ID token",
  "refreshToken": "Firebase refresh token",
  "expiresIn": 3600,
  "user": {
    "id": "firebase-uid",
    "email": "user@example.com",
    "emailVerified": true
  }
}
```

ログイン成功時、Firestoreの `mojidasUsers/{uid}` にメール確認状態、最終ログイン日時、状態を記録します。

### `POST /api/mojidas/auth/refresh`

```json
{
  "refreshToken": "Firebase refresh token"
}
```

新しい `accessToken` と、Firebaseが返した最新の `refreshToken` を返します。クライアントは両方を置き換えてください。

### `POST /api/mojidas/auth/password-reset`

```json
{
  "email": "user@example.com"
}
```

アカウントの存在を第三者へ知らせないため、登録の有無にかかわらず同じ202応答を返します。

### `GET /api/mojidas/me`

```http
Authorization: Bearer {accessToken}
```

確認済みユーザーのIDとメールアドレスを返します。IDトークンはFirebase Admin SDKで失効確認を含めて検証します。

### `POST /api/mojidas/acp/trial-appkey`

未ログインの60秒体験用に、ACPの短期APIキーを発行します。Firebase認証は不要ですが、接続元IPごとに1分8回までに制限します。

```json
{"recognitionRunID":"550e8400-e29b-41d4-a716-446655440000"}
```

### `POST /api/mojidas/acp/instant-appkey`

Firebase IDトークンとFirestore上の有効な`creditReservations`を確認してから、ACPの短期APIキーを発行します。

```http
Authorization: Bearer {accessToken}
```

```json
{"reservationID":"reservation-id"}
```

両endpointの成功応答は同じです。

```json
{
  "appKey": "short-lived-api-key",
  "expiresAt": "2026-08-14T01:02:00.000Z"
}
```

## エラー形式

```json
{
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "メールアドレスとパスワードを入力してください。"
  }
}
```

代表的なHTTPステータス:

| Status | 用途 |
| --- | --- |
| 400 | 入力不備 |
| 401 | 認証失敗・期限切れ |
| 403 | メール未確認・利用停止 |
| 409 | メールアドレス登録済み |
| 429 | 試行回数制限 |
| 502 / 503 / 504 | Firebaseまたはサーバー設定・接続エラー |

## レート制限

現在は各Expressプロセスのメモリ上で、接続元IPごとに次を制限します。

| API | 上限 |
| --- | --- |
| register | 1時間に5回 |
| login | 15分に20回 |
| refresh | 15分に120回 |
| password-reset | 1時間に5回 |

Herokuを複数dynoで運用すると制限がプロセスごとになるため、その段階でRedis等の共有ストアへ移行してください。

## 必須設定

既存の管理ログインと同じ環境変数を利用します。

- `FIREBASE_API_KEY`
- `FIREBASE_ADMIN_CREDENTIALS`
- `FIREBASE_PROJECT_ID`（推奨）
- `MOJIDAS_ALLOWED_HOSTS`（任意。既定値は`app.mojidas.jp`、複数指定はカンマ区切り）
- `ACP_SERVICE_ID`
- `ACP_SERVICE_PASSWORD`
- `ACP_API_KEY_EXPIRY_MS`（任意。既定値120000、30000〜600000に制限）

`ACP_SERVICE_ID`と`ACP_SERVICE_PASSWORD`はHeroku Config Vars等のサーバー秘密情報として設定し、Git、Webページ、Mac/Windowsアプリへ含めません。サーバーはACP公式の`POST https://acp-api.amivoice.com/issue_service_authorization`へ`application/x-www-form-urlencoded`で送信します。

Firebase ConsoleでEmail/Passwordプロバイダーを有効にし、Authentication Templatesの確認メール・パスワード再設定メールをMojidas向けに設定してください。

## 確認方法

```sh
npm test
```

実在ユーザーを作成する統合確認は、Firebaseの開発プロジェクトまたはAuth Emulatorで実施してください。本番メールアドレスを自動テストへ埋め込まないでください。
