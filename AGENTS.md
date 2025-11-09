# Repository Guidelines

## Project Structure & Module Organization
- `app.js` wires middleware (Express, sessions, i18n) and registers routers from `routes/`; `bin/www` is the sole entrypoint, so external tooling should call `node ./bin/www`.
- Business logic stays in `modules/`, static assets live under `public/`, and user-facing markup is rendered from `views/` (EJS). Keep generated files outside these trees.
- Localization bundles sit in `locales/` and design sources in `psd/`; touch the relevant trio (`views/`, `locales/`, `public/`) whenever copy or assets change.

## Build, Test, and Development Commands
```bash
npm install        # fetch dependencies
npm start          # boot the app via bin/www on localhost:3000
DEBUG=otomi-net:* npm start  # enable verbose server logging
```
Use `npm start` for both local and production parity; prefer adding a dedicated `dev` script if you need nodemon or extra flags.

## Coding Style & Naming Conventions
- Target Node 16+, default to `const` and modern syntax supported by the current toolchain.
- Match the repo style: two-space indentation, single quotes, trailing commas. Introduce ESLint rules via `.eslintrc` before enforcing new checks.
- Name routers after their path (`routes/channel.js`) and keep modules atomic (`modules/video/fetchMetadata.js`). Static assets favor kebab-case filenames, while translation keys mirror feature paths (`channel.settings.save`).

## Testing Guidelines
- No automated suite exists yet; place new specs under `tests/` or `modules/__tests__/` and wire them through a fresh `npm test` script that exits nonzero on failure.
- For now, rely on manual verification: run `npm start`, hit the touched route (`curl http://localhost:3000/api/health`), and record results in the PR, including screenshots for UI edits.

## Commit & Pull Request Guidelines
- History shows short, descriptive subjects (often Japanese sentences); stick with that voice or optionally use `feat:`/`fix:` prefixes when clarity improves.
- Each commit should address one concern, cite related issues, and explain the user-facing change in the body.
- PRs need a crisp summary, validation steps (commands, browsers, bots), and media for UI changes. Note any config deltas beyond the default `ROOT_URL=http://localhost:3000`.

## Localization & Configuration Tips
- Runtime configuration flows through `dotenv`; copy `.env` from `_env` and at minimum set `ROOT_URL`. Keep LINE channel secrets outside Git.
- When adding strings, update each `locales/<lang>.json` entry and keep keys alphabetized so diffs stay readable.
- Firebase Adminのサービスアカウントは `FIREBASE_ADMIN_CREDENTIALS` 環境変数にJSON（またはbase64エンコードしたJSON）で格納します。`.env` で複数のキーをばらまかないよう注意してください。
- SendGridを利用する機能では `SENDGRID_API_KEY` と `SENDGRID_FROM_EMAIL` を必須で設定し、ドキュメント (`docs/ADMIN_AUTH.md`) の制約に従ってください。

## Admin Authentication
- `/admin` のログインはサーバーサイドで完結させます。ビューからFirebase SDKを読み込まず、`routes/admin.js` 内でメールアドレス＋パスワードを受け取りFirebase Authへ問い合わせてください。
- 新しい管理機能を追加するときも同じセッション（`sessionCookie`）を信頼し、フロントエンドではクッキー以外のトークン処理を行わないでください。

## Agent Communication
- すべてのコメント、コミット説明、Pull Requestの議論は日本語で行ってください。READMEや本書の更新が必要な場合も日本語でまとめ、英語を併記する際は日本語版を優先します。
