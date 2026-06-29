# Stamina Reminder Bootstrap (Phase 0〜3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** stamina-reminder の開発基盤 (環境、Discord App、GitHub repo、プロジェクト雛形、CI/CD 設定一式) を整え、ローカルで `bun run check` が green になる状態を作る。

**Architecture:** Bun + Hono + TypeScript + Biome + Vitest + lefthook + commitlint。CI は GitHub Actions の `check` job (lint:code / typecheck / test / actionlint / zizmor)。Workers Builds が deploy 担当 (Phase 4 以降)。secrets は GitHub に 0 個、Cloudflare 側で管理。

**Tech Stack:** Bun (固定 version)、Hono v4、TypeScript、Biome v2 系、Vitest、lefthook、commitlint、@commitlint/config-conventional、wrangler (devDep)、actionlint / zizmor (PATH バイナリ)、`@types/bun` (Bun 専用 globals 用)。

> Biome は本計画策定時点で v2.x が安定版。`@biomejs/biome@latest` を取ると v2 になる。v1 から `organizeImports` の置き場所や `include`/`ignore` フィールド名が変わっているため、本計画書の `biome.json` は **v2 構造** で書く (Task 7)。v1 系を採用したい場合は `bun add -D @biomejs/biome@^1` と明示し、本計画の Task 7 構造を v1 形式 (`organizeImports.enabled` 直書きなど) に置換する分岐を採る。

## Global Constraints

- パッケージマネージャ: Bun 固定。`packageManager` フィールドで pin、`bun.lock` を必ず commit。
- install フラグ: ローカル/CI/Workers Builds で `bun install --frozen-lockfile --ignore-scripts` (初回 bootstrap のみ `bun install --ignore-scripts`)。
- npm/npx/yarn は使わない。
- 環境変数ファイルは `.dev.vars` のみ (`.env` 系は使わない)。
- `bun.lock` は `.gitignore` に書かない (= 必ず commit)。
- Conventional Commits (scope 禁止、subject case 任意)。
- リポジトリ: `9c5s/stamina-reminder` (Public)、デフォルトブランチ `main`、rebase merge のみ、linear history 必須。
- third-party action は完全 40 文字 hex SHA pin (`@v4` 等は禁止)。`# vX.Y.Z` コメントを併記。
- Workers Builds の Build Secrets は 0 個。`BUN_VERSION` / `SKIP_DEPENDENCY_INSTALL` のみ Plain text。
- Cloudflare account_id = `b40fdc1cf09112832597f6e05f829cae` (9c5s)。
- `<BUN_VERSION_PIN>`、`<BIOME_PIN>` 等の placeholder は **実行時に最新 stable に解決して埋め込む** (本計画書本文はそのまま docs/ 配下に残るが、リポジトリ実体 (package.json/yml) には placeholder を残さない)。

## Files

このフェーズで作成/変更するファイル:

- Create: `package.json` (`bun create hono` の出力を spec §4 に整形)
- Create: `bun.lock` (`bun install` の出力)
- Create: `tsconfig.json`
- Create: `biome.json`
- Create: `vitest.config.ts`
- Create: `lefthook.yml`
- Create: `commitlint.config.ts`
- Create: `.gitignore`
- Create: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`
- Create: `scripts/check-pins.sh`
- Create: `scripts/check-pins.test.ts` (TDD でこれを先に書く)
- Create: `src/index.ts` (Hono 雛形、Stage1 計画 Task 4 で完全書き換え。bootstrap では `bun create hono` の出力をそのまま置く)
- Modify: `HANDOFF.md` (spec round 13 PASS との同期は既に済んでいるはずだが、Phase 完了時に再確認)
- Modify: `docs/architecture.md` (同上)

このフェーズで作成しない (Phase 4 以降で作成):
- `wrangler.toml`, `src/commands.ts`, `src/handlers/**`, `src/durable-objects/**`, `src/lib/**`, `scripts/register-commands.ts`, `.dev.vars`

## Interfaces

- Produces:
  - `package.json` の `scripts`: `lint:code`, `lint:code:fix`, `lint:actions`, `lint`, `typecheck`, `test`, `test:watch`, `check`, `ci`, `deploy`, `register-commands`, `check-pins`
  - `package.json` の `packageManager`: `bun@<BUN_VERSION_PIN>`
  - `bun.lock` (commit 必須)
  - `scripts/check-pins.sh` を `bun run check-pins` で起動できる状態
  - CI workflow `Check` (`.github/workflows/ci.yml` の job 名) が PR / push (main) / workflow_dispatch でトリガー可能
  - dependabot が github-actions / bun の週次更新 PR を作成可能
- Consumes:
  - 既存ドキュメント: `HANDOFF.md`, `docs/architecture.md`, `docs/superpowers/specs/2026-06-29-github-cicd-design.md` (spec)
  - 開発者ホストの PATH: `bun`, `git`, `actionlint`, `zizmor` (および Windows なら Git Bash)
  - Discord Developer Portal アクセス (Phase 1)
  - GitHub アカウント (`9c5s`)
  - Cloudflare アカウント (account_id `b40fdc1cf09112832597f6e05f829cae`)

---

### Task 1: 開発ホスト前提の確認

**Files:**
- なし (ホスト確認のみ、ファイル作成は次タスク)

**Interfaces:**
- Consumes: PATH の `bun`, `git`, `actionlint`, `zizmor` (および Windows なら Git Bash)
- Produces: 確認済みの開発ホスト状態

- [ ] **Step 1: Bun 入っているか確認**

```sh
bun --version
```

期待: バージョン文字列 (例 `1.2.20`) が出力される。未インストールなら https://bun.com/docs/installation に従って入れる。

- [ ] **Step 2: Bun の version 値をメモする**

出力された version を以下の Step で使うため控える。本計画書本文では `<BUN_VERSION_PIN>` と書くが、リポジトリ実体に書くときは具体値 (例: `1.2.20`) に置換する。

- [ ] **Step 3: Git Bash (Windows 限定) の確認**

Windows 環境のみ実施:

```sh
bash --version
```

期待: GNU bash の文字列が出る (lefthook の POSIX シェルジョブが Git Bash に依存)。macOS/Linux はデフォルトシェルでよい。

- [ ] **Step 4: actionlint をインストール**

Windows (Scoop が入っている前提):

```powershell
scoop install actionlint
```

macOS:

```sh
brew install actionlint
```

Linux:

`https://github.com/rhysd/actionlint/releases/latest` から該当 OS のバイナリを `~/.local/bin` 等に配置し PATH を通す。

確認:

```sh
actionlint --version
```

- [ ] **Step 5: zizmor をインストール**

Windows:

```powershell
scoop install zizmor
```

macOS:

```sh
brew install zizmor
```

Linux:

`https://github.com/zizmorcore/zizmor/releases/latest` からバイナリを `~/.local/bin` 等に配置。

確認:

```sh
zizmor --version
```

- [ ] **Step 6: Cloudflare 認証の事前確認 (Phase 4 で使う)**

```sh
bunx wrangler whoami
```

未ログインなら:

```sh
bunx wrangler login
```

期待: `9c5s` (account_id `b40fdc1cf09112832597f6e05f829cae`) として認識される。

- [ ] **Step 7: Git の user.name / user.email が設定済み**

```sh
git config --global user.name
git config --global user.email
```

両方値が出ること。未設定なら設定する (Conventional Commits に直接関係ないが、commit signing の前提となる)。

---

### Task 2: Discord Application 作成

**Files:**
- なし (Discord Developer Portal 上の作業のみ。値は Phase 4 で `wrangler.toml [vars]` と `.dev.vars` に書く)

**Interfaces:**
- Consumes: Discord アカウント
- Produces: 控えるべき 3 値 (`DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`) と 1 招待 URL

- [ ] **Step 1: New Application を作成**

`https://discord.com/developers/applications` を開く → `New Application` → 名前 `stamina-reminder` (任意) → `Create`。

- [ ] **Step 2: General Information から 2 値を控える**

- `APPLICATION ID` → 後で `DISCORD_APPLICATION_ID` として使う
- `PUBLIC KEY` → 後で `DISCORD_PUBLIC_KEY` として使う (**Ed25519 公開鍵で Discord Developer Portal にも明示される公開値**、Secret 扱いしない。`wrangler.toml [vars]` に 64 hex literal で commit する仕様、spec §9 / architecture §7)

- [ ] **Step 3: Bot を作成して token を控える**

`Bot` メニュー → `Reset Token` → 表示された token を控える → 後で `DISCORD_BOT_TOKEN` (= Cloudflare Runtime secret) として使う。**token は再表示されないので必ず保存する**。

- [ ] **Step 4: Privileged Intents を OFF にする**

`Bot` メニュー内の `Privileged Gateway Intents` セクションで以下すべて OFF:
- PRESENCE INTENT: OFF
- SERVER MEMBERS INTENT: OFF
- MESSAGE CONTENT INTENT: OFF

理由: 本 bot は Interactions Endpoint 方式で Slash コマンドのみ扱う。Gateway を使わないため intent は不要。

- [ ] **Step 5: Bot 招待 URL を組み立て、招待**

以下の `<APP_ID>` を Step 2 の APPLICATION ID に置換した URL をブラウザで開く:

```
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=2048
```

`permissions=2048` = Send Messages のみ。任意の自分のサーバーを選んで `認証` する。

- [ ] **Step 6: 3 値を安全な場所に一時保管**

ローカル secrets ストア (パスワードマネージャ、`D:\projects\cloudflare\.secrets\` 配下のファイル等) に書く。Phase 4 step で `.dev.vars` に書き写し、`wrangler secret put` で投入する。**Discord チャンネル / コミット履歴 / Git に push しない**。

---

### Task 3: GitHub リポジトリ作成と main ブランチ作成

**Files:**
- Create: `.git/` (`git init` の出力)

**Interfaces:**
- Consumes: GitHub アカウント `9c5s`
- Produces: GitHub リポジトリ `9c5s/stamina-reminder` (Public)、`main` ブランチに空 commit

- [ ] **Step 1: GitHub 側で repo を作成 (UI または gh)**

UI 経由:
- `https://github.com/new` → Owner: `9c5s`、Repository name: `stamina-reminder`、Visibility: **Public**
- Initialize は **すべてオフ** (README/`.gitignore`/license は空、ローカルから push する)
- `Create repository`

または gh CLI:

```sh
gh repo create 9c5s/stamina-reminder --public --description "Discord stamina reminder bot on Cloudflare Workers"
```

注意: Public リポジトリでも secrets は GitHub に置かない方針 (Cloudflare Runtime secrets と `.dev.vars` でローカル管理) のため公開しても token 露出は無い。`.gitignore` で `.dev.vars*` と `.env*` をパターン除外している。Workers Builds の `Non-production branch builds: 無効` (stage1 計画 Task 7) と branch protection 前段 (Task 4 Step 2) により fork からの PR は production deploy をトリガしない。

- [ ] **Step 2: ローカルで git init**

```sh
cd /d/projects/stamina-reminder
git init -b main
```

期待: `Initialized empty Git repository in D:/projects/stamina-reminder/.git/`

- [ ] **Step 3: origin を設定**

```sh
git remote add origin https://github.com/9c5s/stamina-reminder.git
```

確認:

```sh
git remote -v
```

期待: `origin https://github.com/9c5s/stamina-reminder.git (fetch)` と `(push)` の 2 行。

- [ ] **Step 4: 既存 docs を初期 commit する前に、最小 .gitignore を作って tmp 配下を弾く**

これは後で Task 11 で正規 `.gitignore` に置換するが、初期 commit に `node_modules/` が紛れないように先に置く。

```sh
cat > .gitignore <<'EOF'
node_modules/
.dev.vars
.dev.vars.*
.env
.env.*
.wrangler/
dist/
*.tsbuildinfo
.DS_Store
Thumbs.db
EOF
```

- [ ] **Step 5: 既存ドキュメント (HANDOFF.md, docs/) を含む初期 commit**

```sh
git add HANDOFF.md docs/ .gitignore
git status
```

期待: `HANDOFF.md`, `docs/architecture.md`, `docs/superpowers/specs/2026-06-29-github-cicd-design.md`, `.gitignore` (および本計画書 `docs/superpowers/plans/*` も) がステージされる。

```sh
git commit -m "chore: initialize repository"
```

注意: この commit は lefthook がまだ install されていないため hook を経由しない (lefthook は Task 8 で install)。conventional commit 規約には準拠する。

- [ ] **Step 6: main を push**

```sh
git push -u origin main
```

期待: `origin/main` が作成され、ブラウザで GitHub UI に commit が見える。

---

### Task 4: GitHub repo 一般設定 + branch protection 前段 (spec §12 step 3)

**Files:**
- なし (GitHub UI または gh CLI 経由の設定のみ。`Require status checks` は stage1 計画 Task 10 で初回 CI 完走後に追加する)

**Interfaces:**
- Consumes: Task 3 Step 6 で push 済みの `main`
- Produces: rebase only / Wiki / Discussions / Auto-delete head branches の一般設定 + branch protection 前段 (PR 必須 + linear history + force push 禁止 + delete 禁止) が反映された状態。`Require status checks` のみまだ未設定 (CI workflow 初回完走を待つため)。Task 5 以降は **必ず feature branch 経由で PR を作る** 運用に切り替わる

- [ ] **Step 1: 一般設定を UI から変更 (`Settings → General`)**

- Default branch: `main` (既定)
- Features:
  - Wiki: **OFF**
  - Issues: **ON**
  - Discussions: **OFF**
- Pull Requests:
  - Allow merge commits: **OFF**
  - Allow squash merging: **OFF**
  - Allow rebase merging: **ON** (これのみ)
  - Automatically delete head branches: **ON**

または gh CLI:

```sh
gh repo edit 9c5s/stamina-reminder \
  --enable-wiki=false \
  --enable-issues=true \
  --enable-discussions=false \
  --enable-merge-commit=false \
  --enable-squash-merge=false \
  --enable-rebase-merge=true \
  --delete-branch-on-merge=true
```

確認:

```sh
gh repo view 9c5s/stamina-reminder --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,deleteBranchOnMerge,hasWikiEnabled,hasDiscussionsEnabled
```

期待: rebaseMergeAllowed=true、それ以外の merge 系と Wiki/Discussions は false、delete 系は true。

- [ ] **Step 2: branch protection 前段を有効化 (`Settings → Branches → Add rule`)**

ブランチ名パターン: `main`

ON にするもの:
- Require a pull request before merging: **ON**
  - Required approvals: **0** (1 人作業のため。増員時に 1 に上げる)
- Require linear history: **ON**
- Do not allow bypassing the above settings: **ON**

OFF のまま:
- Require status checks to pass before merging: **OFF** (stage1 計画 Task 10 で `Check` を required check として追加する。Check 名は workflow が一度走るまで GitHub UI で選択肢に出ない)
- Allow force pushes: **OFF**
- Allow deletions: **OFF**

`Create` / `Save changes` を押す。

注意: spec §12 step 3 に従いここで branch protection 前段を入れる (= Task 5 以降は必ず feature branch + PR で `main` に入れる)。Task 5 Step 0 で `feat/bootstrap-config` ブランチを切るため、protection 後の `main` 直接 push 禁止は作業を阻害しない。

- [ ] **Step 3: branch protection が反映されたか確認**

```sh
gh api repos/9c5s/stamina-reminder/branches/main/protection
```

期待: `required_pull_request_reviews` および `required_linear_history.enabled=true` 等が出る (404 が返る場合は protection rule がまだ反映されていない → 数秒待ってリトライ、または UI で保存できているか確認)。

---

### Task 5: Hono プロジェクト雛形を作成し package.json を整形

**Files:**
- Create: `package.json`
- Modify: `src/index.ts` (`bun create hono` が生成するが、Phase 5 で完全書き換えるためここでは「存在する」状態だけ確保。中身は触らない)

**Interfaces:**
- Consumes: Bun, `bun create hono` の `cloudflare-workers` テンプレート
- Produces: `package.json` (spec §4 準拠)、Hono を含む `dependencies`、空の `src/index.ts`、feature branch `feat/bootstrap-config` (Task 5〜14 はすべてこの branch で commit する)

- [ ] **Step 0: feature branch を切る**

Task 5〜14 のすべての commit を `feat/bootstrap-config` ブランチに集約するため、ここで branch を切る。Task 4 Step 2 で `main` への直接 push は branch protection により禁止されているため、feature branch + PR ルートが必須になる。

```sh
git checkout main
git checkout -b feat/bootstrap-config
```

期待: 現在のブランチが `feat/bootstrap-config`。

- [ ] **Step 1: bun create hono でテンプレを生成**

`stamina-reminder` ディレクトリは既にあるため、cwd を空にしてからではなく、別の一時ディレクトリで生成して必要ファイルだけコピーする方式を採る:

```sh
mkdir -p /tmp/hono-bootstrap
cd /tmp/hono-bootstrap
bun create hono@latest stamina-reminder --template cloudflare-workers --install false --git false
```

期待: 対話プロンプトなしで `/tmp/hono-bootstrap/stamina-reminder/` 配下に Hono の最小テンプレが作られる (`src/index.ts`, `package.json`, `tsconfig.json`, `wrangler.toml`/`wrangler.jsonc` 等)。

- [ ] **Step 2: 必要ファイルだけ本プロジェクトにコピー (上書き不可なファイルは避ける)**

```sh
cd /tmp/hono-bootstrap/stamina-reminder

# src/index.ts (Phase 5 で書き換えるが雛形として置く)
mkdir -p /d/projects/stamina-reminder/src
cp src/index.ts /d/projects/stamina-reminder/src/index.ts

# package.json は spec §4 に整形するので、コピーせずに参照だけ
cat package.json
```

`wrangler.toml`/`wrangler.jsonc` は **コピーしない** (Phase 4 で spec §12 step 12 に従って正規版を書く)。

`/tmp/hono-bootstrap` は削除して良い:

```sh
rm -rf /tmp/hono-bootstrap
cd /d/projects/stamina-reminder
```

- [ ] **Step 3: package.json を spec §4 構成で新規作成**

`<BUN_VERSION_PIN>` 等は Task 1 Step 2 でメモした実値 / 後述 Step で取得した実値で置換する。

```jsonc
{
  "name": "stamina-reminder",
  "private": true,
  "type": "module",
  "packageManager": "bun@<BUN_VERSION_PIN>",
  "scripts": {
    "lint:code": "biome check .",
    "lint:code:fix": "biome check --write .",
    "lint:actions": "actionlint && zizmor --pedantic --no-online-audits .github/workflows .github/dependabot.yml",
    "lint": "bun run lint:code && bun run lint:actions",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "bun run lint:code && bun run typecheck && bun run test",
    "ci": "bun run lint && bun run typecheck && bun run test",
    "deploy": "wrangler deploy",
    "register-commands": "bun scripts/register-commands.ts",
    "check-pins": "bash scripts/check-pins.sh"
  },
  "dependencies": {
    "discord-interactions": "<DISCORD_INTERACTIONS_PIN>",
    "hono": "<HONO_PIN>"
  },
  "devDependencies": {
    "@biomejs/biome": "<BIOME_PIN>",
    "@cloudflare/workers-types": "<WORKERS_TYPES_PIN>",
    "@commitlint/cli": "<COMMITLINT_PIN>",
    "@commitlint/config-conventional": "<COMMITLINT_PIN>",
    "@types/bun": "<TYPES_BUN_PIN>",
    "lefthook": "<LEFTHOOK_PIN>",
    "typescript": "<TS_PIN>",
    "vitest": "<VITEST_PIN>",
    "wrangler": "<WRANGLER_PIN>"
  },
  "trustedDependencies": []
}
```

`Write` ツールで `package.json` を作成する。

- [ ] **Step 4: 各 PIN プレースホルダを実値に置換**

各ライブラリの最新 stable を取得してから書き戻す。たとえば:

```sh
bun info @biomejs/biome version
bun info @commitlint/cli version
bun info @cloudflare/workers-types version
bun info lefthook version
bun info typescript version
bun info vitest version
bun info wrangler version
bun info hono version
bun info discord-interactions version
bun info @types/bun version
```

各コマンドの出力 (例: `2.5.1`) を、対応する `<XXX_PIN>` の位置に書き込む。`<BUN_VERSION_PIN>` は Task 1 Step 2 でメモした値。

注意 (Biome v1/v2 分岐):
- `bun info @biomejs/biome version` で得た値が **`2.x.y`** の場合は本計画書の Task 7 (biome.json) の v2 構造をそのまま採用する
- 値が **`1.x.y`** で v1 系を維持したい場合は `bun info @biomejs/biome@1 version` で 1.x の最新を取り直し、Task 7 の biome.json を v1 構造 (`organizeImports.enabled` をトップレベルに置く 等) に置換する。本計画書本文は v2 想定で書かれているため、その場合は注意書きを残して構造を v1 に書き換えること

セマンティック区切り (`^x.y.z` か `x.y.z` か) は Bun 既定 (`^x.y.z`) に統一する。bunx info 出力の version をそのまま入れた後、`bun install` で `^` 付きに正規化される (Step 6 で確認する)。

- [ ] **Step 5: 上記置換後、package.json に placeholder が残らないこと確認**

```sh
grep -E '<[A-Z_]+_PIN>|<BUN_VERSION_PIN>' package.json && echo "FAIL: placeholders remain" || echo "OK"
```

期待: `OK`

- [ ] **Step 6: 初回 bootstrap install (lockfile 未生成のため --frozen-lockfile を付けない)**

```sh
bun install --ignore-scripts
```

期待:
- `bun.lock` がカレントに生成される
- `node_modules/` が作られる
- exit code 0

- [ ] **Step 7: bun.lock と package.json を commit**

```sh
git add package.json bun.lock src/index.ts
git status
```

期待: `package.json` / `bun.lock` / `src/index.ts` が staged。

```sh
git commit -m "chore: scaffold hono project with pinned bun toolchain"
```

---

### Task 6: tsconfig.json を作成

**Files:**
- Create: `tsconfig.json` (Hono 雛形が生成した版は上書き)

**Interfaces:**
- Consumes: `@cloudflare/workers-types` (Task 5 で `devDependencies` 経由)
- Produces: `tsc --noEmit` の対象設定

- [ ] **Step 1: tsconfig.json を spec §16.1 で書く**

`Write` で以下を作成:

```jsonc
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ESNext"],
    "types": ["@cloudflare/workers-types/2026-06-01", "bun"],
    "strict": true,
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "noEmit": true
  },
  "include": ["src/**/*", "scripts/**/*", "vitest.config.ts"]
}
```

注意:
- `types` の `@cloudflare/workers-types/2026-06-01` は Phase 4 で書く `wrangler.toml` の `compatibility_date` と同じ日付を指定する。Phase 4 で日付を変えるならここも同じ値に揃える (本計画書では `2026-06-01` で書くが、実装日に合わせて Phase 4 で再確認する)。
- `types` の `bun` は `@types/bun` (Task 5 で devDep に追加) から来る。これは `scripts/register-commands.ts` (Stage2 Task 11) で使う `Bun.file` / `import.meta.main` 等の Bun 専用 globals に必要 (公式: https://bun.com/docs/typescript)。
- `@cloudflare/workers-types` (Worker runtime 型) と `@types/bun` (Bun runtime 型) を同じ tsconfig に同居させる構成は本計画書の前提。Step 2 の `bun run typecheck` で **型衝突が起きないこと** を実地検証する。万一衝突する場合 (例えば `process` や `console` の宣言が二重するなど) は `tsconfig.scripts.json` を別途作って `scripts/**/*` 用に分離し、`package.json` の `typecheck` を `tsc -p tsconfig.json && tsc -p tsconfig.scripts.json` に変更する (本計画書の現状は同居前提、衝突時のみ分離)。

- [ ] **Step 2: typecheck が空ファイル状態で通るか確認**

```sh
bun run typecheck
```

期待: `tsc --noEmit` が exit 0 で終わる (空の src/index.ts でも検査対象 0 で通る)。

- [ ] **Step 3: commit**

```sh
git add tsconfig.json
git commit -m "chore: add tsconfig for cloudflare workers"
```

---

### Task 7: biome.json を作成

**Files:**
- Create: `biome.json`

**Interfaces:**
- Consumes: `@biomejs/biome` (Task 5 で pin 済み)
- Produces: `biome check .` の lint+format 設定

- [ ] **Step 1: biome.json を v2 構造で書く**

`<BIOME_PIN>` は Task 5 Step 4 で `package.json` に書いた version と同じ値で置換する。本計画書は Biome v2 を前提とした構造 (`organizeImports` を `assist.actions.source` 配下に置く、`include`/`ignore` フィールドは `includes` 配列に統合) で書く (公式 v2 upgrade guide: https://biomejs.dev/guides/upgrade-to-biome-v2/)。Task 5 Step 4 で `bun info @biomejs/biome version` の出力が `1.x.y` だった場合は、本ファイルを v1 構造 (`organizeImports.enabled` トップレベル直書き) に書き換えること。

```jsonc
{
  "$schema": "https://biomejs.dev/schemas/<BIOME_PIN>/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  },
  "assist": {
    "actions": {
      "source": {
        "organizeImports": "on"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "warn" },
      "style": { "noNonNullAssertion": "warn" }
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "always",
      "trailingCommas": "all"
    }
  }
}
```

- [ ] **Step 2: lint:code が通るか確認**

```sh
bun run lint:code
```

期待: `biome check .` が現状 src のみを対象に通る。`bun create hono` が生成した `src/index.ts` の中身次第で format diff が出る場合は次 Step で自動修正する。

- [ ] **Step 3: 必要なら自動修正**

```sh
bun run lint:code:fix
```

期待: format 違反が自動修正される、または「No fixes applied」と出る。

再確認:

```sh
bun run lint:code
```

期待: exit 0。

- [ ] **Step 4: commit**

```sh
git add biome.json src/index.ts
git commit -m "chore: add biome config and format scaffold"
```

---

### Task 8: vitest.config.ts を作成

**Files:**
- Create: `vitest.config.ts`

**Interfaces:**
- Consumes: `vitest` (Task 5 で pin 済み)
- Produces: `vitest run` の対象範囲 (src/**/*.test.ts と scripts/**/*.test.ts、environment=node)

- [ ] **Step 1: vitest.config.ts を spec §16.3 で書く**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/durable-objects/**'],
    },
    reporters: ['default'],
    passWithNoTests: false,
  },
});
```

注意: `passWithNoTests: false` のため、テストファイルが 1 つも無い状態だと `bun run test` が失敗する。Task 9 で `scripts/check-pins.test.ts` (= 最初のテスト) を書くまで `bun run test` は赤いままになる。これは TDD 上の意図された状態。

- [ ] **Step 2: commit**

```sh
git add vitest.config.ts
git commit -m "chore: add vitest config (unit-only scope)"
```

---

### Task 9: commitlint.config.ts を作成

**Files:**
- Create: `commitlint.config.ts`

**Interfaces:**
- Consumes: `@commitlint/cli`, `@commitlint/config-conventional` (Task 5 で pin 済み)
- Produces: commit message に scope を許さない設定 (`feat: ...` OK / `feat(api): ...` NG)

- [ ] **Step 1: commitlint.config.ts を spec §6 で書く**

```ts
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'subject-case': [0],
    'scope-empty': [2, 'always'],
  },
};
```

- [ ] **Step 2: commitlint が動くか手動確認**

```sh
echo "feat: hello" | bunx commitlint
```

期待: exit 0 (lint pass)。

```sh
echo "feat(api): hello" | bunx commitlint
```

期待: exit 1、出力に `scope must be empty` 等のメッセージ。

- [ ] **Step 3: commit**

```sh
git add commitlint.config.ts
git commit -m "chore: add commitlint for conventional commits"
```

---

### Task 10: scripts/check-pins.sh を TDD で実装

**Files:**
- Create: `scripts/check-pins.test.ts`
- Create: `scripts/check-pins.sh`

**Interfaces:**
- Consumes: `git` (`git grep` 使用)、bash
- Produces: `bun run check-pins` で動く placeholder 検出 script。
  - exit 0: placeholder なし
  - exit 1: placeholder 検出 (出力に対象行)
  - 検出対象 (placeholder scan、`<NAME>` 形式):
    - `<SHA>`
    - `<*_PIN>` (`<BUN_VERSION_PIN>`, `<BIOME_PIN>`, `<TYPES_BUN_PIN>` 等)
    - `<APPLICATION_ID>` / `<PUBLIC_KEY>` / `<BOT_TOKEN>` / `<APP_ID>` / `<GUILD_ID>`
    - `<KV_NAMESPACE_ID>` (Stage1 Task 2 で wrangler.toml に置く placeholder)
    - `<実装日 YYYY-MM-DD>`
    - `<subdomain>`
    - `.github/workflows/*.yml` 内の `uses:` で 40 文字 hex SHA pin になっていない参照
  - 検出対象 (secret-like literal scan、placeholder allowlist より広い):
    - `DISCORD_BOT_TOKEN` の右辺が `<...>` placeholder ではなく 20 文字以上の英数記号列の場合 (`Bot ` / `Bearer ` の prefix を挟んでも検出する)
    - **`HANDOFF.md` も scan 対象に含む** (= placeholder allowlist の取りこぼし対策、Round 4 反映)
    - **`DISCORD_PUBLIC_KEY` は secret-like scan 対象外** (Ed25519 公開鍵で `wrangler.toml [vars]` に 64 hex literal で commit する正式仕様、spec §9 / architecture §7、Round 5 反映)
  - scan 除外 (placeholder scan の allowlist):
    - `docs/` 配下 (計画書 / 仕様書本文の placeholder は意図的に残す。secret-like scan でも除外されるため、**`docs/` 配下に実 token を書かないことは手動レビュー責務**)
    - repo root の `HANDOFF.md` (永続的な引き継ぎ書で、placeholder は表記としてそのまま残す)。**secret-like scan の対象には残る** (= HANDOFF.md への `DISCORD_BOT_TOKEN=<実値>` 誤コミットは検出される)
    - `scripts/check-pins.sh` / `scripts/check-pins.test.ts` (検出 script 自身と test ファイルが placeholder 文字列を literal で扱うため自己マッチを避ける)
    - 上記以外のリポジトリ全体が scan 対象

- [ ] **Step 1: テストを書く (失敗する状態)**

`scripts/check-pins.test.ts` を以下で作成:

```ts
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runCheckPins(repoRoot: string) {
  return spawnSync('bash', ['scripts/check-pins.sh'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'check-pins-test-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  // テスト対象の本物のスクリプトを Node fs API でコピー (Windows でも PATH 依存なし)
  const scriptSrc = join(process.cwd(), 'scripts', 'check-pins.sh');
  const scriptDst = join(dir, 'scripts', 'check-pins.sh');
  copyFileSync(scriptSrc, scriptDst);
  chmodSync(scriptDst, 0o755);
  // git init して staging だけ揃える
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  return dir;
}

function commitAll(dir: string) {
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'test'], { cwd: dir });
}

describe('check-pins.sh', () => {
  it('exits 0 when no placeholders remain', () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, 'package.json'), '{"name":"x","packageManager":"bun@1.2.20"}\n');
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'workflows', 'ci.yml'),
      "name: CI\non: push\njobs:\n  c:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n",
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when <SHA> placeholder remains outside docs/', () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, 'foo.txt'), 'value <SHA>\n');
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/<SHA>/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 when <SHA> only appears under docs/', () => {
    const dir = makeTempRepo();
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'spec.md'), 'value <SHA>\n');
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when <BUN_VERSION_PIN> placeholder remains', () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, 'package.json'), '{"packageManager":"bun@<BUN_VERSION_PIN>"}\n');
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/_PIN/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when <KV_NAMESPACE_ID> placeholder remains', () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, 'wrangler.toml'), 'id = "<KV_NAMESPACE_ID>"\n');
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/<KV_NAMESPACE_ID>/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when <BOT_TOKEN> placeholder remains', () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, 'scripts.md'), 'token: <BOT_TOKEN>\n');
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/<BOT_TOKEN>/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when <subdomain> placeholder remains', () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, 'README.md'), 'url: https://x.<subdomain>.workers.dev\n');
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/<subdomain>/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when workflow uses a tag reference instead of full SHA', () => {
    const dir = makeTempRepo();
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'workflows', 'ci.yml'),
      'name: CI\non: push\njobs:\n  c:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Non-SHA uses/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 when workflow uses a 40-char hex SHA', () => {
    const dir = makeTempRepo();
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'workflows', 'ci.yml'),
      'name: CI\non: push\njobs:\n  c:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows local action references (./action) without SHA', () => {
    const dir = makeTempRepo();
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'workflows', 'ci.yml'),
      'name: CI\non: push\njobs:\n  c:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/local\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when DISCORD_BOT_TOKEN appears as a real-looking literal (not placeholder)', () => {
    const dir = makeTempRepo();
    // 20 文字以上の token 風文字列 (Discord bot token は 70 文字程度、最低 20 文字で detect)
    writeFileSync(
      join(dir, 'HANDOFF.md'),
      'DISCORD_BOT_TOKEN=AbCdEfGhIjKlMnOpQrSt.uVwXyZ.0123456789abcdef0123456789\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Secret-like/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when DISCORD_BOT_TOKEN has Bot prefix with a real-looking literal', () => {
    const dir = makeTempRepo();
    writeFileSync(
      join(dir, 'HANDOFF.md'),
      'DISCORD_BOT_TOKEN=Bot AbCdEfGhIjKlMnOpQrSt.uVwXyZ.0123456789abcdef0123456789\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Secret-like/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when DISCORD_BOT_TOKEN has Bearer prefix with a real-looking literal', () => {
    const dir = makeTempRepo();
    writeFileSync(
      join(dir, 'HANDOFF.md'),
      'DISCORD_BOT_TOKEN=Bearer AbCdEfGhIjKlMnOpQrSt.uVwXyZ.0123456789abcdef0123456789\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Secret-like/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 when DISCORD_BOT_TOKEN value is the <BOT_TOKEN> placeholder form', () => {
    const dir = makeTempRepo();
    // HANDOFF.md は placeholder 表記 (<>) なら secret scan で検出されない
    writeFileSync(join(dir, 'HANDOFF.md'), 'DISCORD_BOT_TOKEN=<BOT_TOKEN>\n');
    commitAll(dir);
    const r = runCheckPins(dir);
    // <BOT_TOKEN> 自体は placeholder scan で検出されるが、allowlist で HANDOFF.md は除外、
    // かつ secret scan も `<` 始まりは除外するため、本ケースは exit 0
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 when DISCORD_PUBLIC_KEY is committed as a 64-hex literal (public value, allowed)', () => {
    const dir = makeTempRepo();
    // wrangler.toml に実 64 hex の Ed25519 公開鍵を [vars] で commit するのが正式仕様 (spec §9)。
    // secret-like scan は DISCORD_BOT_TOKEN のみ対象なので、この commit は exit 0 になるべき。
    writeFileSync(
      join(dir, 'wrangler.toml'),
      'DISCORD_PUBLIC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"\n',
    );
    commitAll(dir);
    const r = runCheckPins(dir);
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: テストを走らせて失敗を確認**

```sh
bun run test
```

期待: `scripts/check-pins.test.ts` の全テストが fail (`scripts/check-pins.sh` 未作成)。

- [ ] **Step 3: scripts/check-pins.sh を実装**

`Write` で以下を作成:

```sh
#!/usr/bin/env bash
set -euo pipefail

fail=0
# 検査対象から除外するパス:
# - docs/: 計画書・仕様書本文の placeholder は意図的に残す
# - HANDOFF.md: 永続的な引き継ぎ書、placeholder 表記をそのまま残す (repo root にあり docs/ 配下ではない)
# - scripts/check-pins.sh / scripts/check-pins.test.ts: 自身が placeholder 文字列を literal で扱うため自己マッチを避ける
EXCLUDE=(
  ':!docs/'
  ':!HANDOFF.md'
  ':!scripts/check-pins.sh'
  ':!scripts/check-pins.test.ts'
)

scan() {
  if git grep -nE "$1" -- "${EXCLUDE[@]}" >/dev/null 2>&1; then
    echo "✗ Placeholder found: $1"
    git grep -nE "$1" -- "${EXCLUDE[@]}" || true
    fail=1
  fi
}

scan '<SHA>'
scan '<[A-Z_]+_PIN>'
scan '<APPLICATION_ID>'
scan '<APP_ID>'
scan '<PUBLIC_KEY>'
scan '<BOT_TOKEN>'
scan '<KV_NAMESPACE_ID>'
scan '<GUILD_ID>'
scan '<subdomain>'
scan '<実装日 YYYY-MM-DD>'

# Secret-like literal scan: HANDOFF.md も含めて (= placeholder allowlist より広い対象)
# DISCORD_BOT_TOKEN の右辺が `<...>` placeholder ではなく 20 文字以上の英数記号列の場合に検出
# (Bot / Bearer のような認証 prefix を挟んでも検出する)
# 注意: DISCORD_PUBLIC_KEY は公開値 (Ed25519 公開鍵、spec §9 / architecture §7) のため scan 対象に含めない。
# wrangler.toml [vars] に 64 hex の literal で commit する設計を妨げないようにする。
SECRET_EXCLUDE=(
  ':!docs/'
  ':!scripts/check-pins.sh'
  ':!scripts/check-pins.test.ts'
)
secret_lines=$(git grep -nE 'DISCORD_BOT_TOKEN[[:space:]]*=[[:space:]]*"?((Bot|Bearer)[[:space:]]+)?[^<[:space:]"]{20,}' \
  -- "${SECRET_EXCLUDE[@]}" || true)
if [ -n "$secret_lines" ]; then
  echo "✗ Secret-like literal found (DISCORD_BOT_TOKEN not in <PLACEHOLDER> form):"
  echo "$secret_lines"
  fail=1
fi

uses_lines=$(git grep -nE '^[[:space:]]*-?[[:space:]]*uses:[[:space:]]+\S+' \
  -- '.github/workflows/*.yml' '.github/workflows/*.yaml' || true)
bad_lines=$(echo "$uses_lines" | awk -F'uses:[[:space:]]+' '
  NF > 1 {
    ref = $2
    sub(/[[:space:]].*$/, "", ref)
    if (ref ~ /^\.\.?\//) next
    if (ref !~ /@[0-9a-f]{40}$/) {
      print $0
    }
  }')

if [ -n "$bad_lines" ]; then
  echo "✗ Non-SHA uses: ref found in workflow"
  echo "$bad_lines"
  fail=1
fi

exit $fail
```

実行権限を付ける:

```sh
chmod +x scripts/check-pins.sh
```

- [ ] **Step 4: テストを再実行して green を確認**

```sh
bun run test
```

期待: `scripts/check-pins.test.ts` の全テストが pass。

- [ ] **Step 5: 本リポジトリ上でも check-pins が動くことを確認**

```sh
bun run check-pins
```

期待:
- 現時点では `.github/workflows/ci.yml` がまだ無い (Task 12 で作る)
- `<BUN_VERSION_PIN>` も既に置換済み (Task 5 Step 4)
- biome.json の `<BIOME_PIN>` は Task 7 で置換済み
- → exit 0 で `OK` 相当

万一 placeholder が残っていたら、出力で示されたファイル/行を Task 5 Step 4 や Task 7 Step 1 に戻って修正する。

- [ ] **Step 6: commit**

```sh
git add scripts/check-pins.sh scripts/check-pins.test.ts
git commit -m "feat: add check-pins script with tests"
```

---

### Task 11: .gitignore を spec §16.4 の正規版に置換

**Files:**
- Modify: `.gitignore` (Task 3 Step 4 で作った最小版を spec §16.4 で完全に書き換える)

**Interfaces:**
- Consumes: なし
- Produces: spec §16.4 と一致する `.gitignore`

- [ ] **Step 1: .gitignore を以下で完全上書き**

```gitignore
# Node / Bun
node_modules/

# Bun の lockfile はコミットする (= 除外しない)
# bun.lock  ← この行は書かないこと

# Cloudflare Workers
.wrangler/
.dev.vars
.dev.vars.*
.env
.env.*

# Build artifacts
dist/
*.tsbuildinfo

# IDE / OS
.vscode/
.idea/
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*
```

注意: `bun.lock` を `.gitignore` に書かない (= commit 対象)。spec §4 / §16.4 と整合。

- [ ] **Step 2: bun.lock が tracked のままか確認**

```sh
git ls-files | grep bun.lock
```

期待: `bun.lock` が 1 行出力される。出ない場合は Task 5 Step 7 に戻って `git add bun.lock` を確認。

- [ ] **Step 3: commit**

```sh
git add .gitignore
git commit -m "chore: replace gitignore with spec-conformant version"
```

---

### Task 12: .github/workflows/ci.yml を作成

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `actions/checkout`, `oven-sh/setup-bun`, `raven-actions/actionlint`, `zizmorcore/zizmor-action` (すべて 40 文字 hex SHA pin)
- Produces: GitHub Actions の `Check` job (PR / main push / workflow_dispatch でトリガー)

- [ ] **Step 1: SHA pin に使う最新タグの SHA を取得**

各 action の `Releases` ページで最新タグの commit SHA を取得する。例 (`actions/checkout` の最新 v6.0.2 想定):

```sh
gh api repos/actions/checkout/git/ref/tags/v6.0.2 --jq '.object.sha'
gh api repos/oven-sh/setup-bun/git/ref/tags/v3.0.0 --jq '.object.sha'
gh api repos/raven-actions/actionlint/git/ref/tags/v2.0.1 --jq '.object.sha'
gh api repos/zizmorcore/zizmor-action/git/ref/tags/v0.2.0 --jq '.object.sha'
```

各 action の現時点の最新タグは Releases ページで確認 (タグ名は上記と違うことが多い)。タグが annotated の場合は `.object.sha` が tag object の SHA になるため、`gh api repos/<owner>/<repo>/commits/tags/<tagname> --jq '.sha'` で commit SHA を取り直す:

```sh
gh api repos/actions/checkout/commits/tags/v6.0.2 --jq '.sha'
```

期待: 40 文字の hex SHA。これを以下 Step 2 の `<SHA>` 各箇所に書く。`# vX.Y.Z` コメントも実際のタグに置換する。

`<ACTIONLINT_VERSION_PIN>` (例 `1.7.7`) と `<ZIZMOR_VERSION_PIN>` (例 `1.7.0`) は action がラップする binary の固定 version。`actionlint --version` / `zizmor --version` で取れる現行値、または各 binary の Release ページで取得する。

- [ ] **Step 2: ci.yml を spec §7 で書く**

`<SHA>`、`<BUN_VERSION_PIN>`、`<ACTIONLINT_VERSION_PIN>`、`<ZIZMOR_VERSION_PIN>` を Step 1 で取得した実値に置換しながら作成:

```yaml
name: CI
on:
  workflow_dispatch:
  pull_request:
  push:
    branches: [main]

permissions: {}

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

defaults:
  run:
    shell: bash

jobs:
  check:
    name: Check
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@<SHA> # vX.Y.Z
        with:
          persist-credentials: false
          fetch-depth: 1

      - name: Setup Bun
        uses: oven-sh/setup-bun@<SHA> # vX.Y.Z
        with:
          bun-version: <BUN_VERSION_PIN>

      - name: Install dependencies
        run: |
          set -euo pipefail
          bun install --frozen-lockfile --ignore-scripts

      - name: Check pin placeholders
        run: |
          set -euo pipefail
          bun run check-pins

      - name: actionlint
        uses: raven-actions/actionlint@<SHA> # vX.Y.Z
        with:
          version: <ACTIONLINT_VERSION_PIN>
          shellcheck: false
          pyflakes: false
          cache: false
          github-token: ""
          token: ""

      - name: zizmor (pedantic)
        uses: zizmorcore/zizmor-action@<SHA> # vX.Y.Z
        with:
          version: <ZIZMOR_VERSION_PIN>
          persona: pedantic
          advanced-security: false
          online-audits: false
          token: ""

      - name: App check (lint:code / typecheck / test)
        run: bun run check
```

注意:
- 各 `<SHA>` を 40 文字 hex に、`# vX.Y.Z` コメントを実タグに、各 `<*_PIN>` を実値に置換する
- 置換後に `<SHA>` や `<*_PIN>` が 1 つも残っていないこと

- [ ] **Step 3: ローカルで actionlint + zizmor が通るか確認**

```sh
actionlint .github/workflows/ci.yml
zizmor --pedantic --no-online-audits .github/workflows .github/dependabot.yml
```

期待: 両方 exit 0。`dependabot.yml` がまだ無いと zizmor で warn が出る可能性があるが、Task 13 で作るので無視するか、`.github/workflows` だけ先に対象にする (`zizmor --pedantic --no-online-audits .github/workflows`)。

- [ ] **Step 4: check-pins.sh が ci.yml を許可するか確認**

```sh
bun run check-pins
```

期待: exit 0 (placeholder なし、すべての `uses:` が 40 文字 hex SHA pin)。

- [ ] **Step 5: commit**

```sh
git add .github/workflows/ci.yml
git commit -m "ci: add check workflow with sha-pinned actions"
```

---

### Task 13: .github/dependabot.yml を作成

**Files:**
- Create: `.github/dependabot.yml`

**Interfaces:**
- Consumes: GitHub Dependabot (依存更新)
- Produces: `github-actions` と `bun` の週次更新 PR (`cooldown: 7d`、`patterns: ["*"]` で 1 グループ化)

- [ ] **Step 1: dependabot.yml を spec §11 で書く**

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 7
    groups:
      actions:
        patterns: ["*"]
  - package-ecosystem: bun
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 7
    groups:
      bun:
        patterns: ["*"]
```

- [ ] **Step 2: ローカルで zizmor 全体監査**

```sh
zizmor --pedantic --no-online-audits .github/workflows .github/dependabot.yml
```

期待: exit 0。`dependabot-cooldown` 監査も pass (cooldown を全 updater に付けている)。

- [ ] **Step 3: bun ecosystem の対応バージョン確認**

公式 docs (`https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference`) で `package-ecosystem: bun` は >=v1.2.5、`bun.lock` 互換は >=v1.1.39 と明示されている。Dependabot は GitHub 側がデフォルトで最新版を使うので、ここで version pin する必要はない (本 yaml の構造が版要件を満たすかは GitHub 側保証)。

- [ ] **Step 4: commit**

```sh
git add .github/dependabot.yml
git commit -m "ci: add dependabot config for actions and bun"
```

---

### Task 14: lefthook.yml を作成して hooks を install

**Files:**
- Create: `lefthook.yml`

**Interfaces:**
- Consumes: `lefthook` (Task 5 で devDep pin)、PATH の `actionlint`, `zizmor`, `git`
- Produces: pre-commit (protect-branch / ignored-files / code-style / typecheck / test / ci-lint / lefthook-validate) と commit-msg (commitlint) のローカル hooks

- [ ] **Step 1: lefthook.yml を spec §5 で書く**

```yaml
colors: false
no_tty: true
glob_matcher: doublestar

pre-commit:
  parallel: true
  jobs:
    - name: protect-branch
      run: >
        d=$(git symbolic-ref --quiet --short
        refs/remotes/origin/HEAD 2>/dev/null|sed 's#^origin/##');
        d=${d:-main};
        [ $(git rev-parse --abbrev-ref HEAD) != $d ] ||
        { echo Direct commits to $d are not allowed.&& exit 1; }

    - name: ignored-files
      run: "! git check-ignore {staged_files}"

    - name: code-style
      group:
        piped: true
        jobs:
          - name: format
            glob: "**/*.{ts,js,mjs,json,jsonc}"
            run: bunx biome format --write {staged_files}
            stage_fixed: true
          - name: lint
            glob: "**/*.{ts,js,mjs,json,jsonc}"
            run: bunx biome lint {staged_files}

    - name: typecheck
      glob: "{**/*.ts,tsconfig.json}"
      run: bun run typecheck

    - name: test
      glob: "**/*.ts"
      exclude: '\.d\.ts$'
      run: bun run test

    - name: ci-lint
      group:
        piped: true
        jobs:
          - name: zizmor
            glob: '.github/{workflows/*.{yml,yaml},dependabot.yml}'
            run: zizmor --fix --pedantic --no-online-audits {staged_files}
            stage_fixed: true
          - name: actionlint
            glob: '.github/workflows/*.{yml,yaml}'
            run: actionlint {staged_files}

    - name: lefthook-validate
      glob: lefthook.yml
      run: bunx lefthook validate

commit-msg:
  jobs:
    - name: commitlint
      run: bunx commitlint --edit {1}
```

- [ ] **Step 2: hooks を install**

```sh
bunx lefthook install
```

期待: `sync hooks: ✔` 等の確認出力。`.git/hooks/` 配下に `pre-commit` / `commit-msg` が作られる。

- [ ] **Step 3: lefthook validate**

```sh
bunx lefthook validate
```

期待: exit 0、設定 OK。

- [ ] **Step 4: 短い動作確認 (空ステージで pre-commit 起動)**

```sh
bunx lefthook run pre-commit
```

期待: ステージファイルが無い場合は各 job が skip され、exit 0。

- [ ] **Step 5: hook 経由で lefthook.yml を commit**

Task 5 Step 0 で既に `feat/bootstrap-config` ブランチに居るため、追加で branch 切替は不要。lefthook が install 済の状態で commit すると `protect-branch` job が現在ブランチを確認し、`main` でなければスキップする。

```sh
git add lefthook.yml
git commit -m "chore: add lefthook hooks for pre-commit and commit-msg"
```

期待:
- pre-commit hook が走り、`protect-branch`, `ignored-files`, `code-style` (format → lint), `typecheck`, `test`, `ci-lint`, `lefthook-validate` 各 job が pass (`.github/workflows/ci.yml` 等はまだ無いまたは更新中なので、対応する glob で staged ファイルが無ければスキップ)
- commit-msg hook の `commitlint` が走り、`chore: add lefthook hooks for pre-commit and commit-msg` を pass
- exit 0

- [ ] **Step 6: branch protection 前段が依然有効か確認**

Task 4 Step 2 で既に branch protection 前段 (PR 必須 + linear history + force push 禁止 + delete 禁止) を有効化済み。Task 5〜14 の作業中に意図せず外れていないかをここで確認する:

```sh
gh api repos/9c5s/stamina-reminder/branches/main/protection
```

期待: `required_pull_request_reviews` および `required_linear_history.enabled=true`、`allow_force_pushes.enabled=false`、`allow_deletions.enabled=false` が出る。

万一 protection が外れていた場合は Task 4 Step 2 に戻って再設定する。`Require status checks` の有効化は stage1 計画 Task 10 で CI 初回完走後に行うため、ここでは設定しない。

注意: feature branch `feat/bootstrap-config` は branch protection の影響を受けない (保護は `main` のみ)。

---

### Task 15: 最終確認と PR 作成

**Files:**
- Modify: なし (確認のみ)

**Interfaces:**
- Consumes: 既存の全ファイル
- Produces: GitHub PR `feat/bootstrap-config` → `main`、CI workflow の最初の green run

- [ ] **Step 1: ローカルで bun run check が green**

```sh
bun run check
```

期待: exit 0。`lint:code` / `typecheck` / `test` が順に通る。

- [ ] **Step 2: ローカルで bun run ci (lint:actions 含む) も green**

```sh
bun run ci
```

期待: exit 0。`lint` (lint:code + lint:actions) / typecheck / test が通る。`actionlint` と `zizmor` が PATH のバイナリで実行される。

- [ ] **Step 3: bun run check-pins が green**

```sh
bun run check-pins
```

期待: exit 0。allowlist (`docs/` + `HANDOFF.md` + `scripts/check-pins.*`) 以外に placeholder なし、`HANDOFF.md` と非 `docs/` の tracked file に secret-like literal なし (= `docs/` 配下と `scripts/check-pins.*` は scan 対象外で手動レビュー責務)、`.github/workflows/ci.yml` の全 `uses:` が 40 文字 hex SHA。

- [ ] **Step 4: feature branch を push**

```sh
git push -u origin feat/bootstrap-config
```

期待: GitHub に `feat/bootstrap-config` が作成される。branch protection は `main` のみに有効なので、この push は通る。

- [ ] **Step 5: PR を作成**

```sh
gh pr create \
  --base main \
  --head feat/bootstrap-config \
  --title "chore: bootstrap project (phase 0-3)" \
  --body "$(cat <<'EOF'
## Summary
- Hono on Cloudflare Workers の最小プロジェクト雛形 (`src/index.ts` は Phase 5 で置換)
- Bun 固定 (`packageManager`)、`bun.lock` commit、`bun install --frozen-lockfile --ignore-scripts` 統一
- Biome / Vitest / lefthook / commitlint / tsconfig を spec round 13 PASS に整合
- GitHub Actions `Check` job (lint:code + typecheck + test + actionlint + zizmor) を 40 文字 SHA pin で構築
- Dependabot 週次 (cooldown 7d) を github-actions と bun で
- `scripts/check-pins.sh` を TDD で実装、placeholder scan (allowlist `docs/` / `HANDOFF.md` / `scripts/check-pins.*` を除外) + secret-like literal scan (`DISCORD_BOT_TOKEN` の literal を `HANDOFF.md` 含む非 `docs/` tracked file から検出、`docs/` 配下は手動レビュー責務) + 非 SHA `uses:` 検出 の 3 段構成

## Test plan
- [x] `bun run check` green (lint:code, typecheck, test)
- [x] `bun run ci` green (lint:code + lint:actions, typecheck, test)
- [x] `bun run check-pins` green
- [x] `actionlint .github/workflows/ci.yml` pass
- [x] `zizmor --pedantic --no-online-audits .github/workflows .github/dependabot.yml` pass
- [x] `bunx lefthook validate` pass
- [ ] CI workflow が PR で green になる (この PR で初回実行)

## Related
- `docs/superpowers/specs/2026-06-29-github-cicd-design.md` (round 13 PASS)
- `docs/superpowers/plans/2026-06-29-stamina-reminder-bootstrap.md` (本計画)
EOF
)"
```

期待: PR URL が出力される。

- [ ] **Step 6: GitHub Actions の Check job が green になることを確認**

```sh
gh pr checks --watch
```

期待:
- `Check` job が走る (まだ branch protection の `Require status checks` は未有効、stage1 計画 Task 10 で有効化)
- 数分以内に green

万一 fail したら出力ログを読み、原因に応じて以下に戻る:
- `App check (lint:code / typecheck / test)` fail → Task 5/7/8/10 の該当 step
- `actionlint` fail → Task 12 Step 1-2 の SHA / version 値
- `zizmor (pedantic)` fail → Task 12 (workflows) / Task 13 (dependabot.yml) の構成
- `Check pin placeholders` fail → Task 5 Step 4 / Task 7 Step 1 等の placeholder 取り残し

- [ ] **Step 7: rebase merge して main に反映**

```sh
gh pr merge --rebase --delete-branch
```

期待: PR が rebase merge され、`feat/bootstrap-config` が削除される。

注意: branch protection で `Required approvals: 0` のため self-merge できる。Required approvals が後で 1 以上になったら別アカウントから approve が必要。

- [ ] **Step 8: ローカルの main を最新化**

```sh
git checkout main
git pull --rebase origin main
```

期待: ローカル `main` が GitHub `main` と一致。

---

## Self-Review (writer 用 — 計画書を保存後にこのチェックを通す)

**1. Spec coverage:**
- HANDOFF.md Phase 0 (環境準備): Task 1 で網羅
- HANDOFF.md Phase 1 (Discord Application): Task 2 で網羅
- HANDOFF.md Phase 2 (GitHub repo + branch protection 前段): Task 3 (repo 作成 + main push) / Task 4 (一般設定 + branch protection 前段) で網羅
- HANDOFF.md Phase 3 (プロジェクト雛形 + config 群): Task 5〜15 で網羅
- spec §12 step 1 (GitHub repo 作成): Task 3 Step 1
- spec §12 step 2 (main 空 commit + push): Task 3 Step 2-6
- spec §12 step 3 (branch protection 前段 / 一般設定): Task 4 (一般設定 + branch protection 前段)。Task 14 Step 6 は確認のみ (二重防御)
- spec §12 step 4 (Discord Application): Task 2
- spec §12 step 5 (前提確認 actionlint/zizmor): Task 1 Step 4-5
- spec §12 step 6 (bun create hono + package.json 整形): Task 5
- spec §12 step 7 (bun install --ignore-scripts で lockfile 生成): Task 5 Step 6
- spec §12 step 8 (HANDOFF.md と architecture.md の同期): 既存ドキュメントが round 13 PASS と整合済みのため Task 3 Step 5 で commit 対象に含めた (本計画では同期 step を独立タスクにせず、Phase 完了時の確認に留める)
- spec §12 step 9 (config materialize): Task 6-14
- spec §12 step 10 (lefthook install + bun run check green): Task 14 Step 2 / Task 15 Step 1
- spec §12 step 11 (Cloudflare 認証): Task 1 Step 6 (前倒し)、Phase 4 で実利用

**2. Placeholder scan:**
本計画書内で意図的に残している placeholder (実装者が実値に置換する):
- `<BUN_VERSION_PIN>`、`<BIOME_PIN>`、`<COMMITLINT_PIN>`、`<WORKERS_TYPES_PIN>`、`<TYPES_BUN_PIN>`、`<LEFTHOOK_PIN>`、`<TS_PIN>`、`<VITEST_PIN>`、`<WRANGLER_PIN>`、`<HONO_PIN>`、`<DISCORD_INTERACTIONS_PIN>` (Task 5 Step 3-4 で `bun info` 取得 → 置換)
- `<ACTIONLINT_VERSION_PIN>`、`<ZIZMOR_VERSION_PIN>` (Task 12 Step 1 で取得 → 置換)
- `<SHA>` (Task 12 Step 1 で `gh api` 取得 → 置換)
- `<APP_ID>` (Task 2 Step 5 の招待 URL 内、Discord Developer Portal で取得済の値を URL に書き込む)

これらは本計画書が `docs/superpowers/plans/` 配下に置かれるため、`scripts/check-pins.sh` の placeholder scan 除外 allowlist (`docs/` + `HANDOFF.md` + `scripts/check-pins.*`) に含まれ scan されない (= 計画書本文の placeholder は OK)。リポジトリ実体に書くときに必ず実値で置換すること。`check-pins.sh` 自体は本計画書 Task 10 で `<KV_NAMESPACE_ID>` / `<BOT_TOKEN>` / `<APP_ID>` / `<GUILD_ID>` / `<subdomain>` も検出する構成にしてある。

`HANDOFF.md` の placeholder (例: `<APP_ID>`, `<実装日 YYYY-MM-DD>`) は placeholder scan からは除外される (永続的な引き継ぎ書としての表記を残すため) が、**secret-like literal scan は HANDOFF.md も対象に含む** (Round 4 反映)。これにより `DISCORD_BOT_TOKEN=<実 token>` のような誤コミットは CI が検出する。placeholder 表記 (`DISCORD_BOT_TOKEN=<BOT_TOKEN>`) はマッチしない (`<` で始まる右辺は secret scan の対象外)。`scripts/check-pins.sh` / `scripts/check-pins.test.ts` は scan 実装側 (=自己マッチ回避が目的) なので除外で問題ない。

placeholder 以外の禁止表現 ("TBD", "TODO", "実装は後で", "適切なエラーハンドリング", "Task N と同様") は使っていない。

**3. Type consistency:**
- `package.json` の scripts 名 (`lint:code`, `lint:actions`, `lint`, `typecheck`, `test`, `check`, `ci`, `deploy`, `register-commands`, `check-pins`) は本計画書内で一貫
- `Check` (CI job 名) は Task 12 / Task 15 で同じ綴り
- ファイル名 `lefthook.yml` / `commitlint.config.ts` / `biome.json` / `vitest.config.ts` / `tsconfig.json` / `scripts/check-pins.sh` / `scripts/check-pins.test.ts` / `.github/workflows/ci.yml` / `.github/dependabot.yml` は本計画書内で表記揺れなし
- branch protection の `Require status checks` を `main` ブランチで `Check` job 名で有効化するのは Phase 5 (= `2026-06-29-stamina-reminder-stage1.md` Task 10)。本計画書 Task 4 Step 2 で `Require status checks` 以外の前段 (PR 必須 + linear history + force push 禁止 + delete 禁止) を有効化し、Task 14 Step 6 で確認するだけ。stage1 計画書側でも同じ綴り `Check` を使うこと
