# Stamina Reminder - 引き継ぎ書

最終更新: 2026-06-29

別セッションへの引き継ぎ用の起点ドキュメント。プロジェクトの現状スナップショット、確定事項、次に走るべきステップを集約する。

詳細は以下を参照:
- **CI/CD 基盤の確定仕様**: `docs/superpowers/specs/2026-06-29-github-cicd-design.md` (Codex 13 round で一次資料との突合せ済み、PASS)
- **アプリケーション層の設計とコード雛形**: `docs/architecture.md` (CI/CD 部分は CI/CD spec が優先、本体ロジックはこちらが詳細)

---

## 1. プロジェクト概要

Discord 上でソーシャルゲームのスタミナを管理する個人用 bot。

- ユーザーが `/stamina add <title> <current>` 等のスラッシュコマンドで現在のスタミナを登録
- bot は事前データ (タイトル別の最大値・回復速度) から満タン時刻を算出
- 満タン時刻になったら同じチャンネルでリプライ通知

スケール: ユーザー数 1、投稿/通知ともに 1 日数回。

---

## 2. 確定済み決定事項

### アプリケーション層

| 項目 | 採用 | 理由 |
|---|---|---|
| プラットフォーム | Cloudflare Workers + Durable Objects + KV | エッジ実行 / 無料運用可能 / alarm() で per-user スケジューラ |
| プラン | Workers Free でスタート | 試算上 Free 枠に余裕 (実測してから Paid 判断) |
| bot 形態 | Slash コマンドのみ (Interactions Endpoint 方式) | GatewayShard 削除で構成大幅簡素化、duration 課金ほぼゼロ |
| Web フレームワーク | Hono v4 | Workers デファクト、ミドルウェアで Ed25519 検証を切り離せる |
| スラッシュコマンド | フル構成 (5+ サブコマンド) | `/stamina add/list/cancel` + `/title add/list/remove` |
| タイトルマスタ管理 | 動的 (KV 書き込み) | `/title add` で実行時に追加できる、デプロイ不要 |
| 通知スケジューラ | DO `alarm()` | 1 ミリ秒粒度、at-least-once、指数バックオフ最大 6 回 |
| ユーザー状態 | UserState DO 内蔵 SQLite | per-user、alarm との結合密、最速読み書き |

### CI/CD 層 (CI/CD spec round 13 PASS 反映)

| 項目 | 採用 | 補足 |
|---|---|---|
| パッケージマネージャ | Bun (固定 version) | `packageManager` フィールドで pin、`bun.lock` を commit |
| 開発ツール | Biome (lint+format) / Vitest (純粋ユニット) / wrangler (devDep pin) | Vite+ は不採用 (フロントエンドアセットなし) |
| Git hooks | lefthook (pre-commit + commit-msg) | 全 commit で lint + typecheck + test を実行 |
| Commit 規約 | Conventional Commits (scope 禁止、subject case 任意) | commitlint で強制 (`commitlint.config.ts`) |
| GitHub Actions | `check` job のみ (lint / typecheck / test / actionlint / zizmor) | Workers Builds が deploy 担当、GitHub に secrets 0 個 |
| デプロイ基盤 | Cloudflare Workers Builds | CF↔GitHub OAuth、Production branch のみビルド、custom API Token |
| Secrets 集中先 | Cloudflare ダッシュボード | Runtime secret は `DISCORD_BOT_TOKEN` のみ |
| Public な値 | `[vars]` で宣言 | `DISCORD_APPLICATION_ID`、`DISCORD_PUBLIC_KEY` (Ed25519 公開鍵) |
| Slash コマンド登録 | ローカル手動 (`bun run register-commands`) | コマンド定義変更時のみ、`.dev.vars` 経由 |
| ブランチ運用 | rebase merge のみ、PR 必須 | GitHub Flow + linear history |
| dependabot | `github-actions` + `bun` を週次、`cooldown: 7d` | `bun` ecosystem は `patterns: ["*"]` で 1 グループ |

### 環境固有

| 項目 | 値 |
|---|---|
| プロジェクトディレクトリ | `D:\projects\stamina-reminder` |
| Cloudflare Account ID | `b40fdc1cf09112832597f6e05f829cae` (9c5s) |
| 想定 GitHub リポジトリ | `9c5s/stamina-reminder` (Public) |

---

## 3. 次セッションで最初にやること

順序は **CI/CD spec §12 の 24 step に従う**。HANDOFF.md ではフェーズ単位の概要のみ示す。各 step の具体 (コマンド、設定値、検証手順) は spec §12 と §16 (実装アーティファクト雛形)、そして **実装計画書 (`docs/superpowers/plans/2026-06-29-stamina-reminder-{bootstrap,stage1,stage2}.md`)** を参照。Plan は各 step を Task / Step の checkbox に分解した実行手順書で、Codex レビュー round 8 PASS 済 (詳細は `docs/codex-review-loop.md`)。

| Phase | 対応する実装計画書 (Plan) | 対応する spec §12 step |
|---|---|---|
| Phase 0-3 | `bootstrap.md` (Task 1〜15) | step 1-10 |
| Phase 4-5 | `stage1.md` (Task 1〜11) | step 11-20 |
| Phase 6 | `stage2.md` (Task 1〜18) | step 21-24 |

実装する場合は **Plan を Task 1 から checkbox 順に消化** するのが推奨経路。HANDOFF.md は引き継ぎ書 / 全体俯瞰用、各 Plan は実装者用の詳細手順書という役割分担。

### Phase 0: 環境準備
詳細手順: `docs/superpowers/plans/2026-06-29-stamina-reminder-bootstrap.md` Task 1
- [ ] Bun (`bun --version`) がインストール済み
- [ ] Windows なら Git Bash がインストール済み (lefthook の POSIX シェル前提)
- [ ] `actionlint` / `zizmor` をローカル PATH に配置 (`scoop install actionlint zizmor` 等、CI/CD spec §4 参照)
- [ ] Cloudflare アカウントに wrangler でログイン (`bunx wrangler login`)、9c5s 確認 (`bunx wrangler whoami`)

### Phase 1: Discord Application 作成
詳細手順: `docs/superpowers/plans/2026-06-29-stamina-reminder-bootstrap.md` Task 2
- [ ] https://discord.com/developers/applications で New Application
- [ ] Bot を作成、以下 3 値を控える (CI/CD spec §12 step 4 と一致):
  - `DISCORD_APPLICATION_ID` → `wrangler.toml [vars]` + `.dev.vars`
  - `DISCORD_PUBLIC_KEY` → `wrangler.toml [vars]` + `.dev.vars` (**Ed25519 公開鍵で Discord Developer Portal にも明示される公開値**、Secret 扱いしない)
  - `DISCORD_BOT_TOKEN` → Cloudflare Runtime secret + `.dev.vars`
- [ ] Privileged Intents は不要 (Message Content Intent OFF)
- [ ] 必要 Permissions = `Send Messages` のみ = `2048`
- [ ] 招待 URL:
  ```
  https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=2048
  ```

### Phase 2: GitHub リポジトリと branch protection 前段 (spec §12 step 1-3)
詳細手順: `docs/superpowers/plans/2026-06-29-stamina-reminder-bootstrap.md` Task 3〜4
- [ ] GitHub リポジトリ作成 (`9c5s/stamina-reminder`、Public)
- [ ] `main` 作成 (空 commit を push)
- [ ] branch protection の前段 (`Require status checks` 以外) と repo settings を設定 (Wiki/Discussions オフ、rebase merge のみ、Auto-delete head branches)

### Phase 3: プロジェクト雛形と config 群 (spec §12 step 5-10、§16 雛形)
詳細手順: `docs/superpowers/plans/2026-06-29-stamina-reminder-bootstrap.md` Task 5〜15
- [ ] `bun create hono` でテンプレ生成 → `package.json` を spec §4 に整形 (`packageManager`, scripts, devDependencies)
- [ ] **`bun install --ignore-scripts`** を実行して `bun.lock` を生成、commit
- [ ] **`HANDOFF.md` と `docs/architecture.md` を spec round 13 PASS に同期** (旧 npm/npx/`.env`/PUBLIC_KEY を secret 投入する記述を撤去、本 HANDOFF.md と同期済みの spec への誘導を入れる)
- [ ] config ファイル群を materialize (spec §7, §11, §5, §6, §16 から: `.github/workflows/ci.yml`, `.github/dependabot.yml`, `lefthook.yml`, `commitlint.config.ts`, `biome.json`, `tsconfig.json`, `vitest.config.ts`, `scripts/check-pins.sh`)
- [ ] **placeholder を全実値に置換** (spec §14 末尾チェックリスト: `<SHA>`, `<BUN_VERSION_PIN>`, `<ACTIONLINT_VERSION_PIN>`, `<ZIZMOR_VERSION_PIN>`, `<APPLICATION_ID>`, `<PUBLIC_KEY>`, `<実装日 YYYY-MM-DD>` 等)
- [ ] `bunx lefthook install` で hooks 有効化
- [ ] `bun run check` がローカルで green を確認
- [ ] `bunx wrangler login` (Phase 0 で済んでいれば skip)

### Phase 4: wrangler.toml と Cloudflare 側設定 (spec §12 step 12-17)
詳細手順: `docs/superpowers/plans/2026-06-29-stamina-reminder-stage1.md` Task 1〜8
- [ ] `wrangler.toml` を整備 (第 1 段階用、DO は除外):
  - `name`, `main`, `compatibility_date`, `compatibility_flags`, `preview_urls = false`, `account_id`
  - `[vars] DISCORD_APPLICATION_ID`, `[vars] DISCORD_PUBLIC_KEY`
  - `[[kv_namespaces]] binding = "TITLES"` ← `bunx wrangler kv namespace create TITLES` の出力 ID
  - DO binding と `[[migrations]]` はまだ入れない (Phase 6 で追加)
- [ ] Cloudflare で **custom API Token を発行** (spec §8 のスコープ)、Workers Builds に紐付け (auto-generated は使わない)
- [ ] Workers Builds 設定: Production branch `main`、Build command `bun install --frozen-lockfile --ignore-scripts`、Deploy command `bun run deploy`、Non-production branch builds **無効**
- [ ] Workers Builds の Build Variables に `BUN_VERSION` (Plain text) と `SKIP_DEPENDENCY_INSTALL=1` (Plain text) を登録 (Discord 系 Build Secret は登録しない)
- [ ] `.dev.vars` をローカル作成 (`.gitignore` 済みを確認)

### Phase 5: 第 1 段階デプロイ (PING/PONG のみ、spec §12 step 18-20)
詳細手順: `docs/superpowers/plans/2026-06-29-stamina-reminder-stage1.md` Task 3〜11
- [ ] `src/index.ts` を「Ed25519 verify (`env.DISCORD_PUBLIC_KEY` を `[vars]` から読む) + PING/PONG だけ返す」最小実装
- [ ] PR 作成 → CI green → rebase merge → Workers Builds 自動 deploy
- [ ] CI 走行後、branch protection の後段 (`Require status checks` を `Check` で有効化) を設定
- [ ] Discord Developer Portal で Interactions Endpoint URL に `https://<worker>.workers.dev/interactions` を登録 → PING 検証 → 登録成功

### Phase 6: 第 2 段階実装 (UserState DO + 全 handler、spec §12 step 21-24)
詳細手順: `docs/superpowers/plans/2026-06-29-stamina-reminder-stage2.md` Task 1〜18 (Task 4.5 含む)
- [ ] `src/handlers/stamina.ts`, `src/handlers/title.ts` 実装 (architecture.md §8.2 / §8.3 を spec に整合させて使用)
- [ ] `src/durable-objects/user-state.ts` 実装 (architecture.md §8.4)
- [ ] `src/commands.ts` (architecture.md §8.5)
- [ ] `scripts/register-commands.ts` 実装 (`.dev.vars` + `Bun.file('.dev.vars').text()` + 自前 parser、spec §9 の雛形に従う、architecture.md §8.6 の `dotenv` 記述は無視)
- [ ] `wrangler.toml` に `[[durable_objects.bindings]]` と `[[migrations]] tag = "v1" new_sqlite_classes = ["UserState"]` を追加
- [ ] PR → merge → Workers Builds 自動 deploy ← **以後、migration 前の version への rollback は CF 公式仕様により不可になる**
- [ ] `bunx wrangler secret put DISCORD_BOT_TOKEN` (Phase 1 で控えた token を投入)、§13.3 Stage 1 sanity check 実施
- [ ] ローカルから `bun run register-commands` 実行 (`.dev.vars` から読む)
- [ ] spec §13.3 Stage 2 の post-deploy 検証 (slash command smoke、alarm 経路、tail 監視)
- [ ] 短時間 (1 分等) で満タンになる値で通知テスト

---

## 4. ディレクトリ構成 (実装後の予定)

```
D:\projects\stamina-reminder\
├── HANDOFF.md                     # この引き継ぎ書 (README 兼用)
├── docs\
│   ├── architecture.md            # アプリ層の設計詳細・コード雛形
│   └── superpowers\
│       └── specs\
│           └── 2026-06-29-github-cicd-design.md  # CI/CD 確定仕様
├── .github\
│   ├── workflows\
│   │   └── ci.yml                 # GitHub Actions check job
│   └── dependabot.yml             # bun + github-actions の週次更新
├── src\
│   ├── index.ts                   # Hono entry + Ed25519 middleware + Interactions handler
│   ├── commands.ts                # スラッシュコマンド定義
│   ├── handlers\
│   │   ├── stamina.ts             # /stamina の処理
│   │   └── title.ts               # /title の処理
│   ├── durable-objects\
│   │   └── user-state.ts          # UserState DO (alarm + SQLite)
│   └── lib\
│       ├── discord-rest.ts        # Discord REST 共通クライアント
│       └── titles.ts              # KV からタイトル取得
├── scripts\
│   ├── register-commands.ts       # コマンド一括登録 (Bun.file + .dev.vars)
│   └── check-pins.sh              # SHA / placeholder の残存検出
├── wrangler.toml
├── package.json
├── bun.lock                       # 必ず commit する
├── tsconfig.json
├── biome.json
├── vitest.config.ts
├── lefthook.yml
├── commitlint.config.ts
├── .gitignore
└── .dev.vars                      # ローカル開発用 secret (.gitignore 対象)
```

---

## 5. 参照ドキュメント

### このプロジェクト内
- `docs/superpowers/plans/2026-06-29-stamina-reminder-bootstrap.md` — Phase 0-3 実装計画 (環境 / Discord App / GitHub repo / config 群、Codex round 8 PASS)
- `docs/superpowers/plans/2026-06-29-stamina-reminder-stage1.md` — Phase 4-5 実装計画 (wrangler.toml / PING/PONG deploy / Endpoint URL 登録、Codex round 8 PASS)
- `docs/superpowers/plans/2026-06-29-stamina-reminder-stage2.md` — Phase 6 実装計画 (handlers / UserState DO / register-commands / Stage 2 検証、Codex round 8 PASS)
- `docs/superpowers/specs/2026-06-29-github-cicd-design.md` — CI/CD 確定仕様 (Codex round 13 PASS)
- `docs/architecture.md` — アプリ層の設計詳細とコード雛形 (CI/CD 部分は spec が優先)
- `docs/codex-review-loop.md` — Codex レビューループ運用ガイド (本仕様の round 13 PASS および plan 3 ファイル round 8 PASS に使った方法論、HYPOTHESIS 検証手順、本プロジェクトで verify 済みの一次資料知見、§10 Plan 専用観点)
- 元の調査レポート (A/B 両方の検討経緯あり): `D:\projects\cloudflare\docs\discord-bot-hosting.md`

### 公式ドキュメント
- Hono: https://hono.dev/docs/getting-started/cloudflare-workers
- Discord Interactions: https://discord.com/developers/docs/interactions/overview
- Discord Cloudflare Workers Tutorial: https://discord.com/developers/docs/tutorials/hosting-on-cloudflare-workers
- Cloudflare Durable Objects alarm(): https://developers.cloudflare.com/durable-objects/api/alarms/
- Cloudflare Workers Pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare wrangler rollback / versions: https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/
- Cloudflare Workers Builds: https://developers.cloudflare.com/workers/ci-cd/builds/
- GitHub Dependabot options: https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference
- Bun install (lifecycle scripts / trustedDependencies): https://bun.com/docs/pm/cli/install

### npm
- discord-interactions: https://github.com/discord/discord-interactions-js (`verifyKey` は async)
- discord-api-types: https://discord-api-types.dev/ (TypeScript 型)

---

## 6. 関連メモリ (Claude Code)

- Discord 返信ではマークダウンテーブルを使わない: `C:\Users\shun\.claude\projects\D--projects-stamina-reminder\memory\feedback_discord_no_tables.md`
- Cloudflare 環境構成 (アカウント、ゾーン、トンネル等): `C:\Users\shun\.claude\projects\D--projects-cloudflare\memory\cloudflare-environment.md`
- MCP トークン権限制約: claude.ai コネクタトークンは編集不可、書き込み必要なタスクは Custom API Token を `D:\projects\cloudflare\.secrets\<task>-token` に保存

---

## 7. リスク・注意点 (簡易版)

1. **discord-interactions v4 の `verifyKey` は async** — 必ず `await` する
2. **Worker への raw body の渡し方** — Hono の `c.req.text()` で取得、JSON.parse 前に署名検証する
3. **Slash コマンド変更時の伝搬** — global コマンド更新は最大 1 時間反映遅延、開発中は guild コマンドで登録すると即反映 (`DISCORD_GUILD_ID` を `.dev.vars` に設定)
4. **Discord REST 429** — 通知集中時のレート制限。`Retry-After` を尊重して `setAlarm` で次回時刻に再キュー
5. **alarm() の at-least-once** — 同じ通知が重複しないように、実行時に必ず DB 状態を確認して送信済みなら無視
6. **DO migration を含むデプロイ後の rollback はブロックされる** (CF 公式仕様、spec §13/§14)。Phase 6 以降は前方修正のみ
7. **`bun install --ignore-scripts` がローカル/CI/Workers Builds で必須** — root package の lifecycle script を意図せず動かさない、`trustedDependencies` で個別 opt-in する場合のみ追加
8. **Workers Builds の Build Secret には Discord 系 token を置かない** — register-commands はローカル手動運用、Build 環境内での token 露出を排除
9. **実 `DISCORD_BOT_TOKEN` を HANDOFF/docs/git commit に literal で書かない** — 保存先は password manager / `.dev.vars` (`.gitignore` 対象) / Cloudflare Runtime secret のみ。`scripts/check-pins.sh` の secret-like literal scan は **本 `HANDOFF.md` と `docs/` 以外の tracked file** の誤コミットを検出する (`docs/` 配下と `scripts/check-pins.*` は除外、自己マッチ / 計画書本文の placeholder 表記との衝突回避のため)。**`docs/` 配下に実 token / 実 ID を書かないことは手動レビュー責務** (check-pins では検出されない経路)。`DISCORD_PUBLIC_KEY` は Ed25519 公開鍵で Discord Developer Portal にも明示される公開値のため、`wrangler.toml [vars]` に literal で commit する (secret 扱いしない、spec §9 / architecture §7、secret-like scan の対象外)
