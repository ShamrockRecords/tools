# 管理ログイン仕様

## 概要

`/admin`はMojidasのFirebase Authenticationとは分離した、サーバー管理者専用のログインを使用します。

- 管理者メールアドレスとパスワードハッシュはHeroku Config Vars等の環境変数で管理します。
- 平文パスワードはサーバー設定、Firestore、Firebase Authenticationのいずれにも保存しません。
- パスワードはscryptで検証し、ログイン後は`express-session`のサーバーセッションを使用します。
- ログイン成功時にセッションIDを再生成し、管理者セッションは12時間で期限切れになります。
- 接続元IPごとのログイン試行は15分に10回までです。
- Firebaseの旧`sessionCookie`が残っていても認証には使用せず、ログイン／ログアウト時に削除します。

これによりFirebase Authentication上の利用者はMojidasアプリのアカウント専用として扱えます。

## 必須環境変数

| 変数名 | 用途 |
| --- | --- |
| `ADMIN_EMAIL` | `/admin`へログインできる管理者メールアドレス |
| `ADMIN_PASSWORD_HASH` | `npm run admin:hash-password`で生成したscryptハッシュ |
| `SESSION_SECRET` | Expressセッション署名用の十分に長いランダム値 |
| `SENDGRID_API_KEY` | SendGrid REST API Key（一斉メール送信用） |
| `SENDGRID_FROM_EMAIL` | SendGridで認証済みの送信元メールアドレス |

`SESSION_SECRET`が未設定でも起動はできますが、起動ごとにランダム値となり、サーバー再起動時に全セッションが失効します。本番では必ず固定のランダム値を設定してください。

## 初期設定とパスワード変更

1. 対話可能なターミナルで次を実行します。

   ```sh
   npm run admin:hash-password
   ```

2. 画面上で8文字以上の管理者パスワードを2回入力します。入力文字は表示されません。
3. 出力された値を`ADMIN_PASSWORD_HASH`へ設定します。
4. `ADMIN_EMAIL`と`SESSION_SECRET`も設定してサーバーを再起動します。

パスワードを変更するときは新しいハッシュへ差し替えます。既存セッションも直ちに失効させたい場合は、同時に`SESSION_SECRET`を新しいランダム値へ変更してください。

## ログイン処理

1. `views/admin/login.ejs`から`POST /admin/login`へメールアドレスとパスワードを送信します。
2. サーバーが環境変数のメールアドレスとscryptハッシュを一定時間比較します。
3. 成功時はセッション固定攻撃を避けるためセッションIDを再生成します。
4. 認証が必要な`/admin`配下は、セッション内の`adminUser`だけを確認します。
5. `POST /admin/logout`でサーバーセッションを破棄します。

Firebase IDトークン、Firebase Session Cookie、Firebase Web SDKはこの処理に使用しません。

## Mojidasとの分離

MojidasのデスクトップアプリはFirebase Authenticationを引き続き使用します。JSON API、IDトークン、更新トークン、メール認証コードについては`docs/MOJIDAS_AUTH_API.md`を参照してください。

## 確認

```sh
npm test
```

次にローカル環境へ3つの必須認証変数を設定し、`/admin`で次を確認します。

1. 誤った資格情報ではログインできない。
2. 正しい資格情報では管理画面と`/admin/bulk-mail`を開ける。
3. ログアウト後は保護画面へ戻れない。
