# Mojidas 販売店ポータルの運用

アプリ共通の正本はMojidas資料リポジトリの`docs/CORPORATE_USAGE_SPEC.md`。ここではサーバーの操作と検証を記す。

## 操作

管理者画面は既存の管理サイト（`https://tools.udtalk.jp/admin/mojidas-partners`）で開く。販売店ページの`app.mojidas.jp`限定のホスト制限は管理者画面には適用しない。管理者セッションとPOSTのCSRF検証は必須。

1. `/admin`へ既存の管理者資格情報でログインし、「Mojidas管理」→「Mojidas 販売店・法人利用管理」を開く。Mojidas管理の入口は`/admin/mojidas`。
2. 販売店名・メールアドレスを入力して招待する。メールのリンクは24時間・1回限り。有効期限切れや送信失敗の場合は同じメールへ再招待できる。登録済み販売店のパスワードは再招待で上書きしない。
3. 販売店はメールリンクで8〜128文字のパスワードを設定後、`https://app.mojidas.jp/partners`へログインする。
4. 管理者が「販売店・法人利用管理」の「法人ドメインを追加」を開き、有効な販売店をプルダウンで選択し、組織名とメールドメインを入力する。追加直後から有効。販売店ポータルからの申請と旧申請APIは廃止する。
5. 管理者が同画面で「有効／無効」を変更する。承認フェーズは設けない。サブドメインは個別登録。連絡先・備考・上限等の既存の販売店側詳細編集は維持する。
6. 販売店・管理者の画面で対象月を指定し、認識・正式翻訳の利用時間を確認する。

既存データのapprovedは有効、pending/rejected/suspendedは無効として表示・判定する。課金と利用期間との互換性のため保存値は有効=approved、無効=suspendedを使用する。既存データの一括書き換えは不要。所有者・利用履歴・個人残高・初回有効日・リセット設定は維持し、重複追加で既存の所有者を上書きしない。

## 設定・公開前確認

- 既存のFirebase Admin／Firestore設定を使用。`MOJIDAS_FIRESTORE_ENV`で既存アプリと同じ環境に接続する（省略時production）。検証では隔離環境を明示する。
- メールは既存SendGridを使用。`SENDGRID_API_KEY`、`MOJIDAS_AUTH_FROM_EMAIL`（省略時`no-reply@mojidas.jp`）の認証済み差出人を確認する。
- 管理者設定・`SESSION_SECRET`は`ADMIN_AUTH.md`を参照する。HTTPS・secure cookie前提。セッションはFirestoreへ保存し、ログインから30日間、ブラウザ終了・サーバー再起動・複数インスタンス間で保持する。管理者と販売店のCookie・保存スコープは独立し、ログアウトでは旧セッションを削除する。販売店の有効状態はアクセス時に引き続き確認する。レート制限はプロセスメモリのまま。
- 新collectionはAdmin SDKのみから操作し、一般クライアントからのFirestore直接読み書きを許可しない。既存Firestore rulesが拒否していることをテスト環境で確認する。
- queryはドメインの`partnerID`単一条件のみ。月次集計はdoc IDを指定して読むため追加の複合indexは不要。
- 初回はサーバー全インスタンスの更新完了後にドメインの追加・有効化を始める。旧サーバー混在中の法人利用開始は避ける。
- 実メール・実Firestore・ブラウザ外観・両アプリの認識はテスト環境で通し確認してから公開する。

## 自動テスト

`npm run test:partners`はFirestoreと外部サービスを代替した隔離テスト。localhostのHTTP待受が必要。招待メールを実送信せず、実残高も変更しない。

既存回帰は`tests/mojidas_auth_api.test.js`, `mojidas_credit_api_integrity.test.js`, `mojidas_credit_integrity.test.js`, `mojidas_translation_api.test.js`, `mojidas_account_deletion.test.js`, `mojidas_stripe_billing.test.js`。`npm test`にも法人試験を含める。
