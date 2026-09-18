# UDトーク 設定JSONの監視

`https://service.udtalk.jp/api/properties/udtalk/service_v3.php`を取得し、設定JSONの異常を`info@shamrock-records.jp`へメール通知する。画面、データベース、アプリ内の定期タイマーは追加しない。

## 判定と通知

- HTTP 200、正しいUTF-8、JSON構文、空でないトップレベルのオブジェクトを検証する。カンマ・引用符・括弧の編集ミス、空レスポンス、HTML、`null`、配列、`{}`などを検出する。
- 各設定の業務上の値、キーの過不足、URLの到達性、重複キーは検証しない。数値を文字列で保持する現在の形式や、将来の項目追加を許容する。
- 取得全体が10秒を超える場合、通信中断、HTTPエラー（リダイレクトを含む）、1 MiBを超えるレスポンスも通知対象とする。リダイレクトは追跡しない。
- 異常のたびに1通を送信する。同一の異常も抑制しないため、毎時実行すれば復旧するまで毎時通知する。正常に戻った回から通知しない。復旧メールは送らない。
- メールはURL、検査日時（UTC）、エラー種別・説明、取得できる場合は構文エラーの行・列を含む。設定JSONの本文・値はメール、API応答、ログへ出力しない。
- `notification: "accepted"`はSendGridの受付完了を表す。受信箱への配達完了を表すものではない。メール送信に失敗した場合は失敗結果を返し、次回のスケジュールで再検査・再送信する。

## 環境変数

既存の通常メールと同じSendGridを使用する。[管理ログイン仕様](ADMIN_AUTH.md)も参照。

| 変数 | 用途 |
| --- | --- |
| `SENDGRID_API_KEY` | 必須。メール送信権限を持つSendGrid APIキー |
| `SENDGRID_FROM_EMAIL` | 必須。SendGridで認証済みの差出人アドレス |
| `UDTALK_MONITOR_API_TOKEN` | HTTP APIを使用する場合のみ必須。十分に長いランダムな専用トークン |

通常実行では正常なJSONでもSendGridの設定不足をエラーにする。既存設定があれば追加のメール設定は不要。送信先と監視URLはコード内で固定する。

## Heroku Scheduler

1. 変更をHerokuへデプロイし、上記のSendGrid環境変数を設定する。
2. Heroku Schedulerにジョブを1件追加する。
3. コマンドを`npm run monitor:udtalk-service`、頻度を`Hourly`にする。

Schedulerはone-off dynoでコマンドを実行するため、WebサーバーのURLやAPI用トークンは不要。このジョブはWebサーバーやFirebaseを起動せず、検査が終わると終了する。詳細は[Heroku公式のScheduler説明](https://devcenter.heroku.com/articles/scheduler)を参照。

```sh
# メールを送らずに対象URLを検査する（SendGrid設定不要）
npm run monitor:udtalk-service -- --dry-run

# 通常実行。異常がある場合に通知する
npm run monitor:udtalk-service
```

ログには1行のJSON結果を出力する。終了コードは正常`0`、監視対象の異常`1`、設定不足・メール送信失敗・実行エラー`2`。`--dry-run`でも異常時は`1`となり、通知状態は`skipped`となる。ジョブを重複登録するとその回数分通知されるため、登録は1件にする。

## HTTP API

`POST /api/udtalk/service-properties/check`

`Authorization: Bearer <UDTALK_MONITOR_API_TOKEN>`を指定する。本文は不要で、URL・宛先・通知の有無の外部指定は受け付けない。トークン未設定ではAPIを利用できない。検査と通知はScheduler用コマンドと同じ処理を使う。

```sh
curl --request POST \
  --header "Authorization: Bearer $UDTALK_MONITOR_API_TOKEN" \
  https://YOUR_TOOLS_HOST/api/udtalk/service-properties/check
```

| HTTPステータス | 意味 |
| --- | --- |
| `200` | JSONは正常。`ok: true`、`notification: "not_needed"` |
| `401` | トークンがない、または不一致。検査・通知は実行しない |
| `502` | 監視対象が異常。通知受付済みなら`notification: "accepted"`。送信失敗は`error.code: "ALERT_EMAIL_FAILED"`と`result.notification: "failed"` |
| `503` | API用トークンまたはSendGridの設定不足 |
| `500` | 想定外の実行エラー |

## 検証

```sh
npm run test:udtalk-monitor
npm test
```

ネットワーク異常はローカルHTTPサーバー、メールはSendGridの注入可能な送信処理で検証し、テストでは実メールを送らない。連続異常・プロセス再作成後の再通知、復旧後の停止、構文・文字コード・空データ、タイムアウト・中断・HTTPエラー・サイズ超過、送信失敗、API認証、CLI終了コードを確認する。

## 実装・検証状況（2026-09-18）

- macOS / Node.js v25.1.0で`npm run test:udtalk-monitor`と`npm test`が成功した。
- `bin/www`から一時起動したサーバーで、監視APIのトークンなしPOSTが`401 UNAUTHORIZED`を返すことを確認した。
- 対象の公開URLへ`npm run monitor:udtalk-service -- --dry-run`を実行し、`ok: true`、終了コード`0`を確認した。実メールは送信していない。
- Herokuへのデプロイ、Scheduler登録、SendGridから受信箱までの実配達確認は未実施。次にデプロイ先で環境変数を確認し、毎時ジョブを1件登録する。
