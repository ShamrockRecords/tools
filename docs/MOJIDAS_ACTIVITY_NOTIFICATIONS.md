# 新規登録・時間チャージの運営通知

- 宛先は固定の `app@mojidas.jp`。既存のSendGridと `MOJIDAS_AUTH_FROM_EMAIL`（省略時 `no-reply@mojidas.jp`）、差出人名Mojidasを使用する。
- 新規登録: Firebaseのアカウント作成成功時にユーザーID・メールアドレスを通知する。メール認証の完了通知ではない。確認コード送信が失敗しても作成済みなら対象。登録拒否・ログイン・確認コード再送は対象外。
- 時間チャージ: Stripeの支払済みSessionと商品を検証し、購入時間の付与が成功した後にユーザーID・メール・付与時間・商品金額・決済IDを通知する。無料枠更新、管理者の無償付与、認識・翻訳の消費は対象外。
- パスワード、認証コード、トークン、決済手段はメールに含めない。通知障害は登録・時間付与の確定結果を変更しない。
- `Mojidas/{environment}/activityNotifications`にイベントキーのSHA-256をIDとして送信状態を保存する。新規登録はユーザーID、購入はCheckout Session IDをキーにする（StripeイベントIDではない）。transactionで送信権を先に確保するため、同時受信・Webhook再送・プロセス再起動で二重送信しない。
- メールとDBの原子更新は不可能なため、送信は一度だけ試行する。`attempted`は未確定、`sent`はSendGrid受付済み、`failed`は送信エラー。確保直後の停止や通信結果不明時には通知が欠ける可能性がある。重複回避のため自動再送・常駐リトライはしない。運用でログとSendGrid配送履歴を確認する。通知記録は削除・TTL失効させない（古いWebhook再送の重複防止）。
- Firestore障害で送信権を確保できなければメールは送らず、個人情報を含まない警告を記録する。本番データの遡及通知はしない。
- 自動テストは実メール・本番DBを使わず、`mojidas_verification_email.test.js`（通知ストア試験を含む）と `mojidas_stripe_billing.test.js` で確認する。
