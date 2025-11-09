# 管理ログイン／Firebase 接続仕様

## 概要
- `/admin` はサーバーサイドのみで Firebase Authentication を利用し、ブラウザから直接 Firebase SDK を呼びません。
- Firebase Web SDK と Admin SDK の初期化は `app.js` の起動時に実行され、以降すべてのルーターから共有されます。
- 管理者アカウントの作成・削除は Firebase コンソール（Authentication > Users）で手動管理します。

## 必須環境変数
| 変数名 | 用途 |
| --- | --- |
| `FIREBASE_API_KEY` | Web SDK の API キー（必須） |
| `FIREBASE_AUTH_DOMAIN` | 例: `project.firebaseapp.com` |
| `FIREBASE_PROJECT_ID` | Firebase プロジェクト ID |
| `FIREBASE_STORAGE_BUCKET` | 例: `project.appspot.com` |
| `FIREBASE_MESSAGING_SENDER_ID` | Firebase Messaging の Sender ID |
| `FIREBASE_APP_ID` | Web アプリ ID (`1:xxx:web:yyy`) |
| `MEASUREMENT_ID` | 任意（Analytics を使わない場合は空で可） |
| `FIREBASE_ADMIN_CREDENTIALS` | サービスアカウント JSON をそのまま、または base64 で格納 |
| `SENDGRID_API_KEY` | SendGrid REST API Key（メール送信用、`Mail Send` 権限必須） |
| `SENDGRID_FROM_EMAIL` | 送信元メールアドレス（SendGrid 側で認証済みドメイン/アドレス） |

> `FIREBASE_ADMIN_CREDENTIALS` に JSON を入れる際は改行を維持してください。base64 で格納した場合も自動的にデコードして初期化します。

## ログイン処理フロー
1. 管理画面フォーム (`views/admin/login.ejs`) から `POST /admin/login` にメールアドレスとパスワードを送信。
2. `routes/admin.js` で Firebase Web SDK (`firebase`) を用いて `signInWithEmailAndPassword` を実行。
3. 取得した ID トークンを Firebase Admin SDK (`firebase-admin`) に渡し、`createSessionCookie` で `sessionCookie` を生成。
4. `sessionCookie` は `httpOnly`, `sameSite=lax`, `secure(本番)` でクッキーに保存し、`req.session.user` にデコード済みクレームを保持。
5. Firebase Web SDK からは即座に `signOut()` してクライアントサイドの認証状態を持ち越さない。

## セッションとログアウト
- 認証が必要なビューでは `firebase-admin.auth().verifySessionCookie` を用いて `sessionCookie` を検証し、失効済みならサインイン画面へリダイレクト。
- `POST /admin/logout` では `revokeRefreshTokens(uid)` を呼び、サーバーセッションとクッキーをクリア。

## 一斉メール送信
- `/admin/bulk-mail` ではサーバーサイドが改行区切りの宛先を受け取り、最大1500件までのメールを SendGrid (`https://api.sendgrid.com/v3/mail/send`) に一括送信します。
- 件名・本文は必須で、本文はプレーンテキスト（`text/plain`）として送信されます。
- 入力値はクライアント／サーバーの双方で validation され、重複アドレスは集約、無効な形式や上限超過は警告します。送信前には対象件数を表示するモーダルで確認し、送信処理はAJAX経由で行い、結果はページ遷移なしでバナー表示します（送信中はスピナー表示）。
- 送信成功時は「◯件のメール送信を開始しました。」というメッセージを表示し、フォーム内容をクリアします。失敗時は SendGrid のステータスコードを含むエラーを表示します。
- 実装上は 500件ごとに SendGrid API を複数回呼び出し、送信チャンネルへの負荷を平準化しています。

## エラーハンドリングと確認手順
- Firebase への接続情報が欠けている場合は「Firebaseの設定が不足しているためログインできません。」を表示し、環境変数の再設定を促します。
- 典型的な検証手順:
  1. `.env` に上記キーを設定し `npm start` 。
  2. `/admin` にアクセスしてログインフォームが表示されることを確認。
  3. 既存の管理アカウントでログインし、ダッシュボードが表示されることを確認。
  4. 「ログアウト」を押して `/admin` に戻されること、および再読み込みで未ログイン状態になることを確認。
