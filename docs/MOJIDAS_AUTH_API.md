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

同じ認識ID、heartbeat sequence、終了処理は冪等に扱います。リアルタイムは開始時に時間を予約せず、無音区間を消費しません。2チャンネルは各チャンネルの確定発話区間を個別に合算し、heartbeatと終了時に増加分だけを消費します。ファイル認識は開始時にファイル全時間を退避し、正常完了時はACP確定発話区間だけを消費して差額を返却します。処理エラーまたはlease期限切れでは全量を返却し、利用者が明示的に途中停止した場合はファイル全時間を消費します。毎月無料枠を含む期限付き時間を先に使い、その後に期限なし購入分を使用します。残高・利用セッション・ファイル予約・台帳はFirestore transactionで同時更新します。`grants`はこの消費順で返し、キャンペーン等は任意の`label`を設定できます。

招待ユーザーの予約は`isUnlimited: true`を返し、クレジット付与を予約・消費しません。予約、heartbeat、終了の冪等性と監査用台帳は通常ユーザーと同じ経路を使い、予約台帳の増減時間は0として記録します。

旧未ログイン体験APIは削除済みです。`POST /api/mojidas/acp/trial-appkey`は設定にかかわらず404となり、キーを返しません。

### `POST /api/mojidas/acp/instant-appkey`

Firebase IDトークンとFirestore上の有効な`creditReservations`を確認してから、設定済みの長期APIキーを返します。

```http
Authorization: Bearer {accessToken}
```

```json
{"reservationID":"reservation-id"}
```

成功応答は次の形式です（長期キー使用時は`expiresAt: null`）。

```json
{
  "appKey": "short-lived-api-key",
  "expiresAt": "2026-08-14T01:02:00.000Z"
}
```

### 翻訳API

翻訳APIはすべてFirebase IDトークンを必要とします。翻訳本文はCloud Translation Basic v2の標準NMTだけで生成し、主翻訳、fallback、事後校正、品質判定、意味ブロック生成にLLMを使用しません。Google NMTが失敗した場合も別の生成AIへfallbackせず、翻訳失敗を返します。翻訳先は同NMTモデルが返す全対応言語です。APIキーはサーバーだけが保持し、アプリへ返しません。

翻訳の同一性と差分判定は翻訳結果ではなく原文を正本にします。`sourceTextFingerprint`は原文をNFC正規化したUTF-8のSHA-256で、`sha256-nfc-v1:<lowercase hex>`形式です。サーバーは受信した原文から再計算し、指定fingerprintと一致しなければ`SOURCE_TEXT_FINGERPRINT_MISMATCH`で拒否します。翻訳結果や利用者編集済みの翻訳文は、原文の同一性キーに使用しません。

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
正式翻訳は空の発話を除き、既定で最大2,000発話、本文合計100,000文字まで受け付けます。運用上限はサーバー設定で変更できます。

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

`POST /api/mojidas/translation/formal/estimate`は、上記と同じ`sourceSessionID`、`targetLanguageCode`、`segments`、`reusableBlocks`を受け付けます。`idempotencyKey`は不要です。正式翻訳と同じ意味ブロック生成、原文fingerprint検証、再利用判定、課金区間unionを行いますが、Google翻訳、翻訳job作成、残時間の予約・消費は行いません。

```json
{
  "sourceSessionID": "session-id",
  "targetLanguageCode": "en",
  "targetMilliseconds": 120000,
  "billingRate": 0.5,
  "billableMilliseconds": 60000,
  "totalBlockCount": 10,
  "translationBlockCount": 4,
  "reusedBlockCount": 5,
  "passThroughBlockCount": 1,
  "noTranslationRequired": false
}
```

初回見積もりは同一言語pass-throughを除く全blockが翻訳対象です。更新時は、署名付き再利用候補のうち原文fingerprint等が一致するblockを除いた差分だけが対象になります。`noTranslationRequired`は新たにGoogleへ送るblockがない場合に`true`です。

意味ブロックはserver内で文末記号と文字数上限から決定し、外部LLMは使用しません。Googleの翻訳件数、空文字、応答形式を検証し、全翻訳が成功した場合だけ応答します。

更新時は`reusableBlocks`を省略できます。指定する各候補には、以前の正式翻訳応答blockでサーバーが発行した`reuseToken`が必須です。blockの差分照合・再利用キーは、順序付き発話ID列、原文fingerprint、正規化済み翻訳元・翻訳先言語です。翻訳結果は同一性キーに含めませんが、改ざん防止のためHMAC署名対象に含めます。サーバーは意味ブロック生成後にこのキーが完全一致し、かつHMAC署名が現在のユーザー、provider、pass-through状態、翻訳本文に一致するblockだけを再利用します。署名不一致やsecret変更後の候補はエラーにせず通常翻訳へ戻します。再利用blockはGoogleへ再送せず、`isReused: true`で返し、課金区間にも含めません。ユーザーが編集した表示用翻訳はクライアント側で保持し、`reusableBlocks.translatedText`には保存済みのプロバイダー生成翻訳を指定します。正式翻訳の応答は各blockへ新しい`reuseToken`（署名用secret未設定時は`null`）を含めます。

Googleの429、5xx、タイムアウト等の一時エラーは同一リクエスト内で最大1回だけ再試行します。入力不備、認証失敗、検証失敗は再試行しません。

正式翻訳の`targetMilliseconds`は、対象言語と異なる発話区間を`inputID + recordingID + recognitionRunID`ごとにunionしてから合計した値です。`billableMilliseconds`は`ceil(targetMilliseconds × 0.5)`で、Google翻訳がすべて成功した後にこの時間を既存の残時間から消費します。`billingRate`は`0.5`です。`chargedMilliseconds`は実際の消費量で、時間無制限ユーザーは0です。同一ユーザー・同一`idempotencyKey`の再試行はFirestore台帳で冪等に処理し、二重消費しません。台帳には正規化済み正式翻訳リクエスト全体のSHA-256も保存し、本文等が異なる同一keyは消費時間が偶然同じでも`IDEMPOTENCY_CONFLICT`として拒否します。

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

### アカウント削除

`DELETE /api/mojidas/me`へログイン中のBearer tokenを送ると、購入済み時間を含むクレジット、利用予約、利用履歴、同期済み単語、認証コード、ユーザー記録、Firebase Authenticationユーザーを削除します。削除後は同じメールアドレスで再登録できません。

再登録拒否には、正規化したメールアドレスを`MOJIDAS_ACCOUNT_DELETION_SECRET`でHMAC-SHA256化した値だけを保存し、メールアドレスの平文は保存しません。このsecretを変更または消失すると過去の削除済みメールを照合できなくなるため、本番では固定値として安全に保管します。

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
| translation/formal/estimate | 認証ユーザーごとに1分60回 |
| translation/formal | 認証ユーザーごとに1時間20回 |
| translation/formal/jobs/:jobID | 認証ユーザーごとに1分180回 |

Herokuを複数dynoで運用すると制限がプロセスごとになるため、その段階でRedis等の共有ストアへ移行してください。

正式翻訳はHeroku routerの30秒制限を超える場合があるため、`POST /translation/formal`は
`202 Accepted`と`jobID`を返す。クライアントは同じaccess tokenで
`GET /translation/formal/jobs/:jobID`をpollし、処理中の`202`、完了時の`200`、
失敗時のMojidas error envelopeを処理する。jobは現在Expressプロセスのメモリ上で
30分保持するため、複数dynoへ拡張する際はrate limitと合わせて共有ストアへ移行する。

従量課金保護のため、Google Cloud Translationへの翻訳POSTはtimeout、429、5xxを含めて自動再送しない。対応言語一覧GETだけを1回まで再試行する。正式翻訳jobは2分で未完了requestを中断し、音声認識時間の消費へ進ませずfailedへ遷移するため、無期限に`processing`を返さない。Mac／Windowsは1〜5秒のbackoffで最大3分だけpollし、server再起動などでjobが見つからなくなっても正式翻訳POSTを自動再送しない。polling GET自体はGoogle翻訳を呼ばず、翻訳料金を消費しない。

意味ブロックはLLMへ依存せず、`。`、`！`、`？`と半角の`.!?`を分割候補にする。
既定60文字へ達した後の最初の文末記号でblockを閉じ、文末記号が現れない場合は
既定160文字を上限として分割する。1発話内に複数の文がある場合も文単位へ分ける。
入力、録音、認識実行、認識言語、話者の変化は従来どおりhard boundaryとし、
発話内を分けた断片の時刻は元発話区間へ文字量で比例配分する。

## 必須設定

Mojidas専用のFirebase Authentication設定を利用します。`/admin`の管理者ログインはFirebase Authenticationを使用しません。

- `FIREBASE_API_KEY`
- `FIREBASE_ADMIN_CREDENTIALS`
- `FIREBASE_PROJECT_ID`（推奨）
- `MOJIDAS_ALLOWED_HOSTS`（任意。既定値は`app.mojidas.jp`、複数指定はカンマ区切り）
- `MOJIDAS_MONTHLY_FREE_MINUTES`（任意。毎月の無料枠を分単位で指定、既定値`30`）
- `ACP_LONG_TERM_APPKEY`（必須。ACPで発行した無期限の認識用キー）
- `SENDGRID_API_KEY`（Mail Send権限が必要）
- `MOJIDAS_AUTH_FROM_EMAIL`（任意。既定値`no-reply@mojidas.jp`）
- `MOJIDAS_ACCOUNT_DELETION_SECRET`（32文字以上。削除済みメールの再登録拒否用HMAC secret）
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_CREDIT_60M_JPY`
- `STRIPE_PRICE_CREDIT_10H_JPY`
- `MOJIDAS_CHECKOUT_SUCCESS_URL`（任意）
- `MOJIDAS_CHECKOUT_CANCEL_URL`（任意）
- `MOJIDAS_GOOGLE_TRANSLATION_API_KEY`
- `MOJIDAS_TRANSLATION_MAX_SEGMENTS`（任意。正式翻訳1回の最大発話数。`1`〜`10000`、既定値`2000`）
- `MOJIDAS_TRANSLATION_MAX_TEXT_CHARACTERS`（任意。正式翻訳1回の本文合計文字数。`1000`〜`1000000`、既定値`100000`）
- `MOJIDAS_API_BODY_LIMIT`（任意。Mojidas APIの受信上限。`64kb`〜`25mb`、既定値`3mb`）
- `MOJIDAS_TRANSLATION_BLOCK_MIN_CHARACTERS`（任意。文末でblockを閉じる最小文字数。既定値`60`）
- `MOJIDAS_TRANSLATION_BLOCK_MAX_CHARACTERS`（任意。文末記号がない意味blockの上限。既定値`160`）
- `MOJIDAS_TRANSLATION_REUSE_SECRET`（任意。正式翻訳blockの再利用署名用。未設定時はGoogle翻訳API keyを使用）

`ACP_SERVICE_ID`・`ACP_SERVICE_PASSWORD`・`ACP_API_KEY_EXPIRY_MS`・`ACP_API_KEY_ISSUER_URL`は使用しません。ACPへの短期キー発行通信は削除済みです。旧環境変数が残っていても読み取りません。

StripeのSecret KeyとWebhook signing secretもHeroku Config Varsだけに設定します。2つのPriceは税込支払額330円／2,200円のone-time PriceとしてStripe側で作成し、各Price IDを上記環境変数へ設定します。test modeとlive modeのKey・Price・Webhook secretを混在させないでください。

翻訳用のGoogleキーと再利用署名secretもHeroku Config Vars等のサーバー秘密情報として設定します。GoogleキーはCloud Translation APIだけにAPI制限し、可能なら本番サーバーの送信元IP制限も設定してください。`MOJIDAS_TRANSLATION_REUSE_SECRET`がなければGoogleキーをHMAC署名にも使用し、両方なければ再利用候補を信用せず通常翻訳へ戻します。いずれの秘密情報もURL、ログ、Webページ、Mac／Windowsアプリ、Firestoreへ含めません。

### 長期APPKEYへの切り替え（2026-09-10）

`ACP_LONG_TERM_APPKEY`へACPで発行した無期限の認識用キーを設定すると、認証済みの`POST acp/instant-appkey`はリアルタイム・ファイルとも常にそのキーと`expiresAt: null`を返します。URL・要求JSON・応答フィールドは維持します。認証と予約の有効性・所有者確認は省略せず、応答は`Cache-Control: no-store`とします。旧`acp/trial-appkey`は全面削除済みで、長期キー設定の有無にかかわらず404となります。ログイン必須の既存アプリが対象であり、廃止済み未ログイン体験との互換性は保証しません。

`ACP_LONG_TERM_APPKEY`が未設定・空・形式不正の場合は`ACP_NOT_CONFIGURED`を返します。短期キー発行へのフォールバックはありません。キーの実際の有効性はACP側で確認が必要です。

旧アプリはnullableの期限を受け取れますが、辞書・言語変更時のAPI取得要求は従来どおり残ります。今回削減するのはサーバーからACPへのキー発行通信です。メモリ上のキー再利用によるアプリ側の単純化は別対応です。課金・予約・ファイル送信方式は変更しません。

設定はサーバープロセス作成時に読みます。ローテーションは新キーを設定してプロセスを更新し、新しい取得要求での利用を確認してからACP側で旧キーを失効させます。環境変数の変更だけでは旧キーは失効しません。稼働中アプリや待機中ファイルjobは旧キーを保持し得るため、旧キー失効には移行猶予が必要です。キーをGit・ログ・URLへ残さず、アプリではファイル保存せずメモリで保持します。今回は本番設定・デプロイ・旧キー失効を実行していません。

確認メールはSendGrid v3 Mail Send APIから送り、アプリへ入力する6桁の認証コードを記載します。コードの平文は保存せず、ランダムsaltを付けてscryptでハッシュ化し、Firestoreの`Mojidas/production/emailVerificationChallenges/{uid}`へ有効期限・失敗回数とともに保存します。`mojidas.jp`はSendGrid側でDomain Authenticationが完了している必要があります。

MojidasのFirestoreデータはルートコレクション`Mojidas`、環境ドキュメント`production`の配下へ保存します。`MOJIDAS_FIRESTORE_ENV`を設定した検証環境では、`production`の代わりにその値を使用します。

Firebase ConsoleでEmail/Passwordプロバイダーを有効にしてください。メール確認はMojidas独自コード方式で行い、パスワード再設定メールだけはFirebase Authentication Templatesを使います。

## 確認方法

```sh
npm test
```

実在ユーザーを作成する統合確認は、Firebaseの開発プロジェクトまたはAuth Emulatorで実施してください。本番メールアドレスを自動テストへ埋め込まないでください。
# アプリのバージョン記録

認証リクエストに任意の`X-Mojidas-Platform`（`macos` / `windows`）と`X-Mojidas-Version`（Macは3要素、Windowsは4要素の技術バージョン）を付ける。
`auth/login`・`auth/refresh`・`auth/verify-email`の認証成功時、認証結果のユーザーIDを使い、Mojidasのusersドキュメントの`appClients.<platform>.version`と`lastSeenAt`（サーバー時刻）へmerge保存する。OS別に最後に受信した値を残し、他OSや既存アカウント情報を上書きしない。リフレッシュでは`lastLoginAt`を更新しない。

旧アプリのヘッダーなし・不正な形式は記録せず、そのまま認証を処理する。記録の保存障害は認証を失敗させない。自己申告情報なので認証・権限・強制アップデートの判定には使用しない。同一OSの複数端末は最後の通信の値となり、端末別履歴ではない。新規の定期通信はなく、対象の認証成功1回につき追加のFirestore書込1回、追加の読込は0回。

本変更のサーバーデプロイとアプリ更新後に記録が始まる。「Mojidasユーザー管理」の最終アプリバージョン列に、OS別のバージョンと確認日時を表示する。
