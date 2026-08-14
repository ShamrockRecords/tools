# Mojidas 認証API

## 概要

macOS / Windows版Mojidasから利用する、メールアドレス＋パスワード認証のJSON APIです。Firebase Authenticationを認証基盤として使い、デスクトップアプリはFirebase IDトークンをBearerトークンとして送信します。

- Base path: `/api/mojidas`
- 本番URL: `https://app.mojidas.jp/api/mojidas`
- Content-Type: `application/json`
- 本番環境ではHTTPS必須
- メールで届く6桁の認証コードの確認が完了するまでログイン不可
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
- 成功時は6桁の認証コードを生成し、SendGridから確認メールを送信します。
- 送信元は既定で `Mojidas <no-reply@mojidas.jp>` です。
- 認証コードの有効期限は10分、入力は1回の発行につき5回までです。再送すると以前のコードは無効になります。
- すでに作成済みで未確認のアカウントは、ログインを試すと新しい認証コードを再送します。

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

### `POST /api/mojidas/auth/verify-email`

```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

認証コードが正しければFirebase Authenticationのメール確認状態を更新します。成功後、クライアントは通常のログインAPIを呼び出してトークンを取得します。

```json
{"verified": true}
```

### `POST /api/mojidas/auth/verification/resend`

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

資格情報を確認して新しい認証コードを発行します。アカウント探索に悪用されないよう、メールアドレスだけでは再送できません。

```json
{"verificationRequired": true}
```

### `POST /api/mojidas/auth/login`

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

確認済みメールだけ成功します。未確認の場合は新しい認証コードを再送し、`EMAIL_NOT_VERIFIED`を返します。

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

### `GET /api/mojidas/credits/balance`

確認済みユーザーの利用可能時間と付与内訳を返します。初回取得時と毎月の更新時は、Firebaseのアカウント作成日時を起点とする1時間の無料枠をFirestoreへ冪等に作成します。

```http
Authorization: Bearer {accessToken}
```

```json
{
  "availableMilliseconds": 3600000,
  "expiringMilliseconds": 3600000,
  "purchasedMilliseconds": 0,
  "grants": [{
    "id": "monthly_xxx",
    "type": "monthlyFree",
    "remainingMilliseconds": 3600000,
    "expiresAt": "2026-09-14T01:00:00.000Z"
  }],
  "serverTime": "2026-08-14T01:00:00.000Z"
}
```

### 利用時間予約API

- `POST /api/mojidas/usage/reservations`: 認識開始前に時間を予約
- `POST /api/mojidas/usage/{id}/heartbeat`: 15秒ごとに累積利用時間を報告し、ライブ認識の予約を延長
- `POST /api/mojidas/usage/{id}/complete`: 利用時間を確定して未使用予約を返却
- `POST /api/mojidas/usage/{id}/cancel`: 中断分を確定して未使用予約を返却

同じ認識ID、heartbeat sequence、終了処理は冪等に扱います。期限付き無料枠を先に使用し、残高・予約・台帳はFirestore transactionで同時更新します。

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
| verify-email | 15分に10回 |
| verification/resend | 1時間に5回 |
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
- `SENDGRID_API_KEY`（Mail Send権限が必要）
- `MOJIDAS_AUTH_FROM_EMAIL`（任意。既定値`no-reply@mojidas.jp`）

`ACP_SERVICE_ID`と`ACP_SERVICE_PASSWORD`はHeroku Config Vars等のサーバー秘密情報として設定し、Git、Webページ、Mac/Windowsアプリへ含めません。サーバーはACP公式の`POST https://acp-api.amivoice.com/issue_service_authorization`へ`application/x-www-form-urlencoded`で送信します。

確認メールはSendGrid v3 Mail Send APIから送り、アプリへ入力する6桁の認証コードを記載します。コードの平文は保存せず、ランダムsaltを付けてscryptでハッシュ化し、Firestoreの`emailVerificationChallenges/{uid}`へ有効期限・失敗回数とともに保存します。`mojidas.jp`はSendGrid側でDomain Authenticationが完了している必要があります。

Firebase ConsoleでEmail/Passwordプロバイダーを有効にしてください。メール確認はMojidas独自コード方式で行い、パスワード再設定メールだけはFirebase Authentication Templatesを使います。

## 確認方法

```sh
npm test
```

実在ユーザーを作成する統合確認は、Firebaseの開発プロジェクトまたはAuth Emulatorで実施してください。本番メールアドレスを自動テストへ埋め込まないでください。
