# Tools

Node.js + Expressで開発しています。

## 動かし方
1. Node.jsをインストールします

2. npm install

展開後のフォルダで実行します。

3. .envを作成してプロジェクト直下に配置

※_envファイルは雛形ですのでご利用ください

以下の内容をコピーしてプロジェクトのルートフォルダに.envファイルを作成してください。

```
ROOT_URL = "http://localhost:3000"
```

### 動作させるドメイン

動作させるドメインを入力してください。

`ROOT_URL = "http://localhost:3000"`

Heroku等で動かす場合はこれらをインスタンスの環境編集に登録してください。

## UDトーク設定JSONの監視

`service_v3.php`を検査し、異常が続く間は毎回`info@shamrock-records.jp`へ通知します。Heroku Schedulerで`npm run monitor:udtalk-service`を`Hourly`に設定してください。環境変数、HTTP API、検証方法は[設定JSON監視の説明](docs/UDTALK_SERVICE_PROPERTIES_MONITOR.md)を参照してください。



# Mojidas API

macOS / Windows版Mojidas向けのメール登録・ログインAPIを `/api/mojidas` に提供します。エンドポイント、Firebase設定、トークンの扱いは [`docs/MOJIDAS_AUTH_API.md`](docs/MOJIDAS_AUTH_API.md) を参照してください。

