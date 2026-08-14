# Firestore 利用ガイド

## 概要

このプロジェクトでは、ブラウザから Firestore へ直接アクセスせず、Express のルートや `modules/` 内の処理から Firebase Admin SDK を使います。共通の接続入口は `modules/firestore.js` です。

Firebase Admin SDK は Firestore セキュリティルールを迂回します。ルート側で管理者セッションの確認、入力値の検証、アクセス可能なドキュメントの制限を必ず行ってください。

## 事前準備

1. Firebase コンソールで対象プロジェクトの Firestore Database を作成します。
2. `.env` の `FIREBASE_ADMIN_CREDENTIALS` に、対象プロジェクトのサービスアカウント JSON、またはその JSON を base64 エンコードした値を設定します。
3. 必要に応じて `FIREBASE_PROJECT_ID` に Firebase プロジェクト ID を設定します。サービスアカウント JSON 内の `project_id` と同じ値を使ってください。
4. `npm start` でアプリを再起動します。

認証を含む環境変数の詳細は `docs/ADMIN_AUTH.md` を参照してください。認証情報そのものは Git に追加しないでください。

## 利用例

ルートからドキュメントを追加する例です。

```js
const { getFirestore, serverTimestamp } = require('../modules/firestore');

router.post('/items', ensureAdmin, async function (req, res, next) {
  try {
    const name = (req.body.name || '').trim();

    if (!name) {
      return res.status(400).json({ message: 'nameは必須です。' });
    }

    const documentRef = await getFirestore().collection('items').add({
      name,
      createdAt: serverTimestamp(),
      createdBy: req.adminUser.uid,
    });

    return res.status(201).json({ id: documentRef.id });
  } catch (error) {
    return next(error);
  }
});
```

ドキュメントを取得する例です。

```js
const snapshot = await getFirestore().collection('items').doc(itemId).get();

if (!snapshot.exists) {
  return res.status(404).json({ message: 'データが見つかりません。' });
}

return res.json({
  id: snapshot.id,
  ...snapshot.data(),
});
```

## ローカルエミュレーター

Firestore Emulator を利用する場合は、アプリ起動前に `FIRESTORE_EMULATOR_HOST` を設定します。Admin SDK が自動的にエミュレーターへ接続します。

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm start
```

実運用の認証情報を設定した状態で、開発用のテストデータを誤って本番 Firestore に書き込まないよう注意してください。
