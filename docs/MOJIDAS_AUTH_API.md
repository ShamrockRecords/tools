# Mojidas 認証API

## 概要

macOS / Windows版Mojidasから利用する、メールアドレス＋パスワード認証のJSON APIです。Firebase Authenticationを認証基盤として使い、デスクトップアプリはFirebase IDトークンをBearerトークンとして送信します。

- Base path: `/api/mojidas`
- 本番URL: `https://app.mojidas.jp/api/mojidas`
- Content-Type: `application/json`
- Request body上限: 1 MiB
- 本番環境ではHTTPS必須
- メールで届く6桁の認証コードの確認が完了するまでログイン不可
- IDトークンの有効期間はFirebase応答の `expiresIn` を参照
- 更新トークンはOSの資格情報ストア（macOS Keychain / Windows DPAPI）へ保存
- `app.mojidas.jp`以外の公開ホストでは404を返す（ローカル開発用の`localhost`、`127.0.0.1`、`::1`を除く）

### `GET /api/mojidas/configuration`

認証前にも利用できる公開設定を返します。クライアントは起動時に取得してキャッシュし、無料枠と購入商品の表示に使用できます。秘密情報やStripe Price IDは含みません。

```json
{
  "schemaVersion": 1,
  "monthlyFreeAllowanceMilliseconds": 2400000,
  "products": [{
    "id": "credit_60m_jpy",
    "label": "60分購入",
    "milliseconds": 3600000,
    "totalJPY": 330,
    "currency": "JPY"
  }]
}
```

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

ログイン成功時、Firestoreの `Mojidas/production/users/{uid}` にメール確認状態、最終ログイン日時、状態を記録します。

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

確認済みユーザーの利用可能時間と付与内訳を返します。初回取得時と毎月の更新時は、Firebaseのアカウント作成日時を起点とする30分の無料枠をFirestoreへ冪等に作成します。

```http
Authorization: Bearer {accessToken}
```

```json
{
  "isUnlimited": false,
  "availableMilliseconds": 2400000,
  "expiringMilliseconds": 2400000,
  "purchasedMilliseconds": 0,
  "configuration": {
    "schemaVersion": 1,
    "monthlyFreeAllowanceMilliseconds": 2400000,
    "products": []
  },
  "grants": [{
    "id": "monthly_xxx",
    "type": "monthlyFree",
    "label": null,
    "remainingMilliseconds": 2400000,
    "expiresAt": "2026-09-14T01:00:00.000Z"
  }],
  "serverTime": "2026-08-14T01:00:00.000Z"
}
```

管理画面で招待ユーザーに設定されたアカウントは`isUnlimited: true`を返します。この場合、後方互換用の`availableMilliseconds`は十分に大きな値を返しますが、Mac／Windowsアプリは数値ではなく`isUnlimited`を正本として「時間無制限」を表示します。招待状態はFirebase Authのcustom claim `mojidasInvitedUnlimited`で管理し、APIは認証リクエストごとに最新のUserRecordから判定します。

### 利用時間セッション／ファイル予約API

- `POST /api/mojidas/usage/reservations`: ライブは時間を確保せず利用セッションを作成、ファイルは全時間を予約
- `POST /api/mojidas/usage/{id}/heartbeat`: 60秒ごとにライブの確定発話時間だけを消費。ファイルは予約のleaseだけを延長
- `POST /api/mojidas/usage/{id}/complete`: ライブの最終発話時間を確定、ファイルの未使用予約を返却
- `POST /api/mojidas/usage/{id}/cancel`: ライブの最終発話時間を確定、ファイルの未使用予約を返却

同じ認識ID、heartbeat sequence、終了処理は冪等に扱います。リアルタイムは開始時に時間を予約せず、無音区間を消費しません。2チャンネルは各チャンネルの確定発話区間を個別に合算し、heartbeatと終了時に増加分だけを消費します。ファイル認識は開始時に全時間を退避し、正常完了時だけ全時間を消費します。処理エラーまたはlease期限切れでは全量を返却し、利用者が明示的に途中停止した場合はファイル全時間を消費します。毎月無料枠を含む期限付き時間を先に使い、その後に期限なし購入分を使用します。残高・利用セッション・ファイル予約・台帳はFirestore transactionで同時更新します。`grants`はこの消費順で返し、キャンペーン等は任意の`label`を設定できます。

招待ユーザーの予約は`isUnlimited: true`を返し、クレジット付与を予約・消費しません。予約、heartbeat、終了の冪等性と監査用台帳は通常ユーザーと同じ経路を使い、予約台帳の増減時間は0として記録します。

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

### 翻訳API

翻訳APIはすべてFirebase IDトークンを必要とします。翻訳先はCloud Translation Basic v2のNMTモデルが返す全対応言語です。APIキーはサーバーだけが保持し、アプリへ返しません。

`GET /api/mojidas/translation/languages?displayLanguage=ja`は、Googleから動的に取得してキャッシュした言語コードと表示名を返します。

```json
{
  "schemaVersion": 1,
  "provider": "googleCloudTranslationBasicV2",
  "displayLanguage": "ja",
  "languages": [{"code":"en","name":"英語"}]
}
```

`POST /api/mojidas/translation/realtime`は、確定済みの1発話を参考翻訳します。同一言語はGoogleへ送らず原文を返します。中国語は`zh`、`zh-CN`、`zh-Hans`、`zh-SG`を簡体字、`zh-TW`、`zh-Hant`、`zh-HK`、`zh-MO`を繁体字の同一グループとして扱います。

```json
{
  "sourceTranscriptID": "transcript-id",
  "sourceLanguageCode": "ja",
  "targetLanguageCode": "en",
  "text": "こんにちは",
  "sourceTextFingerprint": "sha256-nfc-v1:...64桁の16進数...",
  "idempotencyKey": "request-id"
}
```

`POST /api/mojidas/translation/formal`は発話列を意味ブロックへまとめて翻訳します。`inputID`、`recordingID`、`recognitionRunID`、`sourceLanguageCode`、`label`（話者）の境界を跨ぎません。旧セッションでは`recognitionRunID`を省略または`null`にできます。

```json
{
  "sourceSessionID": "session-id",
  "targetLanguageCode": "en",
  "segments": [{
    "id": "transcript-id",
    "inputID": "input-id",
    "recordingID": "recording-id",
    "recognitionRunID": "run-id",
    "sourceLanguageCode": "ja",
    "sourceTextFingerprint": "sha256-nfc-v1:...64桁の16進数...",
    "startMilliseconds": 0,
    "endMilliseconds": 1200,
    "text": "こんにちは",
    "label": "話者1",
    "colorHex": "8B5CF6",
    "recognitionStartedAt": "2026-09-01T01:00:00.000Z"
  }],
  "reusableBlocks": [{
    "sourceTranscriptIDs": ["transcript-id"],
    "sourceTextFingerprint": "sha256-nfc-v1:...64桁の16進数...",
    "sourceLanguageCode": "ja",
    "targetLanguageCode": "en",
    "translatedText": "Hello",
    "provider": "googleCloudTranslationBasicV2",
    "isPassThrough": false,
    "reuseToken": "mojidas-reuse-v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  }],
  "idempotencyKey": "request-id"
}
```

OpenAI Responses APIは発話IDのグループ分けだけに使用し、翻訳・本文修正は行わせません。Structured Outputsを使い、全IDが入力順のまま重複・欠落なく一度ずつ含まれることをサーバーで検証します。Googleの翻訳件数、空文字、応答形式も検証し、全翻訳が成功した場合だけ応答します。

更新時は`reusableBlocks`を省略できます。指定する各候補には、以前の正式翻訳応答blockでサーバーが発行した`reuseToken`が必須です。サーバーは意味ブロック生成後に発話ID列、原文fingerprint、翻訳元・翻訳先言語が完全一致し、かつHMAC署名が現在のユーザー、provider、pass-through状態、翻訳本文に一致するblockだけを再利用します。署名不一致やsecret変更後の候補はエラーにせず通常翻訳へ戻します。再利用blockはGoogleへ再送せず、`isReused: true`で返し、課金区間にも含めません。ユーザーが編集した表示用翻訳はクライアント側で保持し、`reusableBlocks.translatedText`には保存済みのプロバイダー原文を指定します。正式翻訳の応答は各blockへ新しい`reuseToken`（署名用secret未設定時は`null`）を含めます。

Google／OpenAIの429、5xx、タイムアウト等の一時エラーは同一リクエスト内で最大1回だけ再試行します。入力不備、認証失敗、検証失敗は再試行しません。

正式翻訳の`billableMilliseconds`は、対象言語と異なる発話区間を`inputID + recordingID + recognitionRunID`ごとにunionしてから合計した値です。Google翻訳がすべて成功した後、この時間を既存の残時間から消費します。`chargedMilliseconds`は実際の消費量で、時間無制限ユーザーは0です。同一ユーザー・同一`idempotencyKey`の再試行はFirestore台帳で冪等に処理し、二重消費しません。台帳には正規化済み正式翻訳リクエスト全体のSHA-256も保存し、本文等が異なる同一keyは消費時間が偶然同じでも`IDEMPOTENCY_CONFLICT`として拒否します。

### 音声認識時間の購入

`POST /api/mojidas/billing/checkout-session`へログイン済みユーザーが商品IDだけを送ると、Stripe Hosted Checkout URLを返します。金額、付与時間、Stripe Price IDはサーバーの商品表から決定し、アプリから受け取りません。ログイン中のメールアドレスをPaymentIntentの`receipt_email`へ設定し、支払い完了時にStripeから領収書を送信します。

```json
{"productID":"credit_60m_jpy"}
```

商品は`credit_60m_jpy`（60分・税込330円）と`credit_10h_jpy`（10時間・税込2,200円）です。カード情報はStripe画面だけで入力します。

Stripe DashboardではWebhook送信先を次へ設定します。

```text
https://app.mojidas.jp/api/mojidas/billing/stripe/webhook
```

購読イベントは`checkout.session.completed`と`checkout.session.async_payment_succeeded`です。署名検証後にStripeからSession明細を再取得し、支払済み・Price ID一致を確認してから有効期限なしの購入時間を付与します。Checkout Session IDを冪等キーとするため、Webhookが再送されても二重付与されません。

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
| 409 | メールアドレス登録済み、原文／冪等キーの競合、残時間不足 |
| 413 | リクエストまたは翻訳本文のサイズ超過 |
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
| checkout-session | 1時間に20回 |
| translation/languages | 認証ユーザーごとに1分30回 |
| translation/realtime | 認証ユーザーごとに1分120回 |
| translation/formal | 認証ユーザーごとに1時間20回 |
| translation/formal/jobs/:jobID | 認証ユーザーごとに1分180回 |

Herokuを複数dynoで運用すると制限がプロセスごとになるため、その段階でRedis等の共有ストアへ移行してください。

正式翻訳はHeroku routerの30秒制限を超える場合があるため、`POST /translation/formal`は
`202 Accepted`と`jobID`を返す。クライアントは同じaccess tokenで
`GET /translation/formal/jobs/:jobID`をpollし、処理中の`202`、完了時の`200`、
失敗時のMojidas error envelopeを処理する。jobは現在Expressプロセスのメモリ上で
30分保持するため、複数dynoへ拡張する際はrate limitと合わせて共有ストアへ移行する。

## 必須設定

Mojidas専用のFirebase Authentication設定を利用します。`/admin`の管理者ログインはFirebase Authenticationを使用しません。

- `FIREBASE_API_KEY`
- `FIREBASE_ADMIN_CREDENTIALS`
- `FIREBASE_PROJECT_ID`（推奨）
- `MOJIDAS_ALLOWED_HOSTS`（任意。既定値は`app.mojidas.jp`、複数指定はカンマ区切り）
- `MOJIDAS_MONTHLY_FREE_MINUTES`（任意。毎月の無料枠を分単位で指定、既定値`30`）
- `ACP_SERVICE_ID`
- `ACP_SERVICE_PASSWORD`
- `ACP_API_KEY_EXPIRY_MS`（任意。既定値120000、30000〜600000に制限）
- `SENDGRID_API_KEY`（Mail Send権限が必要）
- `MOJIDAS_AUTH_FROM_EMAIL`（任意。既定値`no-reply@mojidas.jp`）
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_CREDIT_60M_JPY`
- `STRIPE_PRICE_CREDIT_10H_JPY`
- `MOJIDAS_CHECKOUT_SUCCESS_URL`（任意）
- `MOJIDAS_CHECKOUT_CANCEL_URL`（任意）
- `MOJIDAS_GOOGLE_TRANSLATION_API_KEY`
- `OPENAI_API_KEY`
- `MOJIDAS_TRANSLATION_BOUNDARY_MODEL`（任意。既定値`gpt-4o-mini`）
- `MOJIDAS_TRANSLATION_REUSE_SECRET`（任意。正式翻訳blockの再利用署名用。未設定時はGoogle翻訳API keyを使用）

`ACP_SERVICE_ID`と`ACP_SERVICE_PASSWORD`はHeroku Config Vars等のサーバー秘密情報として設定し、Git、Webページ、Mac/Windowsアプリへ含めません。サーバーはACP公式の`POST https://acp-api.amivoice.com/issue_service_authorization`へ`application/x-www-form-urlencoded`で送信します。

StripeのSecret KeyとWebhook signing secretもHeroku Config Varsだけに設定します。2つのPriceは税込支払額330円／2,200円のone-time PriceとしてStripe側で作成し、各Price IDを上記環境変数へ設定します。test modeとlive modeのKey・Price・Webhook secretを混在させないでください。

翻訳用のGoogle／OpenAIキーと再利用署名secretもHeroku Config Vars等のサーバー秘密情報として設定します。GoogleキーはCloud Translation APIだけにAPI制限し、可能なら本番サーバーの送信元IP制限も設定してください。`MOJIDAS_TRANSLATION_REUSE_SECRET`がなければGoogleキーをHMAC署名にも使用し、両方なければ再利用候補を信用せず通常翻訳へ戻します。いずれの秘密情報もURL、ログ、Webページ、Mac／Windowsアプリ、Firestoreへ含めません。

通常のリアルタイム認識キーは`ACP_API_KEY_EXPIRY_MS`を使います。credit reservationの`mode`が`mediaFile`の場合は、ACP非同期HTTP v2の待機・再認証を考慮して600000 ms（10分）のキーを発行します。クライアントが送る`purpose`だけでは期限を変更せず、必ず保存済みreservationのmodeを根拠にします。

確認メールはSendGrid v3 Mail Send APIから送り、アプリへ入力する6桁の認証コードを記載します。コードの平文は保存せず、ランダムsaltを付けてscryptでハッシュ化し、Firestoreの`Mojidas/production/emailVerificationChallenges/{uid}`へ有効期限・失敗回数とともに保存します。`mojidas.jp`はSendGrid側でDomain Authenticationが完了している必要があります。

MojidasのFirestoreデータはルートコレクション`Mojidas`、環境ドキュメント`production`の配下へ保存します。`MOJIDAS_FIRESTORE_ENV`を設定した検証環境では、`production`の代わりにその値を使用します。

Firebase ConsoleでEmail/Passwordプロバイダーを有効にしてください。メール確認はMojidas独自コード方式で行い、パスワード再設定メールだけはFirebase Authentication Templatesを使います。

## 確認方法

```sh
npm test
```

実在ユーザーを作成する統合確認は、Firebaseの開発プロジェクトまたはAuth Emulatorで実施してください。本番メールアドレスを自動テストへ埋め込まないでください。
