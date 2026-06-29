# GitHub CI/CD 設計 (stamina-reminder)

- 最終更新: 2026-06-29
- 状態: Discord 合意後、Codex 厳密レビュー round 1 ~ round 12 を反映、**round 13 で PASS** (一次資料との整合性確認済み、残課題なし)
- 関連ドキュメント: `../../../HANDOFF.md`, `../../architecture.md`

---

## 1. 目的

stamina-reminder の CI/CD 基盤を設計する。プロジェクト前提は以下:

- Cloudflare Workers + Hono の個人用 Discord bot (ユーザー数 1)
- ローカル開発・テスト・デプロイの自動化を、最小の secret 数とローカル/CI 同期で実現する
- セキュリティを疎かにしない (zizmor pedantic 準拠、third-party action は SHA pin、最小権限、shell pipefail、依存 cooldown、ライフサイクルスクリプト経由の Build Secret 露出を排除)
- 他プロジェクト (9c5s/node-tcnet, 9c5s/tcnet-viewer) の運用パターンを参考に統一感を持たせる

---

## 2. 確定事項 (要約)

| 項目 | 採用 | 補足 |
|---|---|---|
| デプロイトリガー | `main` push で自動 | Workers Builds が担当 |
| CI スコープ | Biome lint + tsc 型 + Vitest unit + actionlint + zizmor (pedantic, advanced-security off) | GitHub Actions の `check` job |
| Slash コマンド登録 | **ローカル手動運用** (Workers Builds に同居させない) | コマンド定義変更時のみ `bun run register-commands` をローカルから実行。Build Secret の install lifecycle 露出を排除 |
| 環境 | prod 単一 | staging 不要、preview build もオフ (Secret 露出回避) |
| ブランチ運用 | PR ベース (GitHub Flow) | rebase merge のみ許可 |
| ランタイム/ツール | Bun (固定 version) + Vitest + Biome + wrangler (固定 version) | Vite+ は採用見送り (Worker only / フロントエンドアセットなし / wrangler 直接が最短) |
| ローカル/CI 同期 | スクリプトを `check` / `ci` / `lint` に整理 | CI は `check`、ローカルは `ci` (lint:actions を含む) |
| Git hooks | lefthook (pre-commit + commit-msg) | test まで全部走る、PATH バイナリ直接呼出 |
| Commit 規約 | Conventional Commits (scope 禁止、subject case 任意) | commitlint で強制 |
| デプロイ基盤 | Cloudflare Workers Builds | GH に CF/Discord secret を置かない |
| Secrets 管理 | Cloudflare Runtime secrets のみ + custom API token (auto-token 拒否) | Workers Builds の Build **Secrets はゼロ** (BUN_VERSION と SKIP_DEPENDENCY_INSTALL のみ Plain text)、GitHub にも 0 個 |
| ブランチ保護 | `main` に PR + status check 必須、rebase merge のみ | linear history 強制 |
| dependabot | github-actions + bun を週次、`cooldown: 7d` 付き | グルーピングして PR 件数を抑制、SHA 更新は補助で `pinact` |
| Wiki / Discussions | 無効 | Issues は有効に残す |
| Vitest スコープ | **純粋ユニットのみ** | Worker/DO/KV/alarm を再現する integration は対象外 (将来必要なら `@cloudflare/vitest-pool-workers` を別途導入) |
| rollback | `wrangler rollback` (バージョン履歴 100 件) | DO migration が絡む場合の制約を §14 で明記 |

---

## 3. 全体アーキテクチャ

```
┌─────────────────┐                ┌────────────────────────────────┐
│   開発者ローカル  │                │     GitHub Repository           │
│                 │   git push     │   - .github/workflows/ci.yml    │
│  lefthook       │ ────────────►  │   - .github/dependabot.yml      │
│  └ pre-commit   │                │   - branch protection (main)    │
│  └ commit-msg   │                └────────────────────────────────┘
│                 │                       │                  │
│  bun run ci     │                       │ PR / push        │ OAuth + custom token
│  bun run        │                       ▼                  ▼
│   register-     │                ┌────────────┐    ┌────────────────┐
│   commands ←────┼─── コマンド定義 │ GH Actions │    │ Workers Builds │
│   (手動)        │     変更時      │  check job │    │  prod branch のみ │
│  bunx wrangler  │                │  (no secret)│    │  bun install +  │
│   rollback      │                └────────────┘    │  bun run deploy │
└─────────────────┘                                  │  (Discord 秘密  │
                                                     │   未保持)       │
                                                     └────────────────┘
                                                              │
                                                              ▼
                                                     ┌─────────────────┐
                                                     │ Cloudflare      │
                                                     │  Workers (prod) │
                                                     │  + KV + DO      │
                                                     └─────────────────┘
```

要点:

- **`check` (GitHub Actions)**: lint / typecheck / test / workflow audit。secret 不要。PR と main push で走る。
- **`build + deploy` (Workers Builds)**: CF↔GitHub の OAuth 連携。**production branch のみビルド** (preview / 非 production branch build はオフ)。**Build Secret は 0 個** (BUN_VERSION と SKIP_DEPENDENCY_INSTALL のみ Plain text)。register-commands はここに含めない。
- **`register-commands` (ローカル手動)**: コマンド定義 (`src/commands.ts`) を変更した時にのみ、開発者がローカルから `.dev.vars` 経由で実行。GitHub にも Workers Builds にも Discord token を一切置かない構成。
- **Cloudflare 側 API Token は auto-generated を使わず、scoped custom token を発行**して Workers Builds に紐付ける。

---

## 4. ローカル == CI の同期構造

CI のステップを `package.json` の scripts に集約し、ローカルと GitHub Actions が **同じ substep** を呼び出す形にする。スクリプトの **`ci`** はローカル運用、**`check`** は CI workflow (action wrapper で actionlint/zizmor を別途まわすため `lint:actions` を含めない) で使う。命名で混同しないようにする。

```jsonc
{
  "packageManager": "bun@<BUN_VERSION_PIN>", // 例: bun@1.2.20、実装時に最新 stable を pin
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
  "devDependencies": {
    "@biomejs/biome": "<BIOME_PIN>",
    "@commitlint/cli": "<COMMITLINT_PIN>",
    "@commitlint/config-conventional": "<COMMITLINT_PIN>",
    "@cloudflare/workers-types": "<WORKERS_TYPES_PIN>",
    "lefthook": "<LEFTHOOK_PIN>",
    "typescript": "<TS_PIN>",
    "vitest": "<VITEST_PIN>",
    "wrangler": "<WRANGLER_PIN>"
  },
  "dependencies": {
    "discord-interactions": "<DISCORD_INTERACTIONS_PIN>",
    "hono": "<HONO_PIN>"
  }
}
```

- **`packageManager` フィールド** で Bun のバージョンを固定 (Workers Builds 側でも `BUN_VERSION` で同値を参照)
- **`bun.lock` は git にコミット**する。初回 bootstrap (lockfile 未生成時) のみ `bun install --ignore-scripts` (frozen なし) で lockfile を生成、以後は CI / Workers Builds / ローカルすべて `bun install --frozen-lockfile --ignore-scripts` で揃え、再現性とフラグ統一を確保
- **`wrangler` は devDependency として pin**。`bun run deploy` の `wrangler` 呼出は `node_modules/.bin/wrangler` (ローカル binary) を経由する。`bun.lock` と `packageManager` の整合により再現性を担保する
- **`check` と `ci` の使い分け** (重要):
  - `check`: CI workflow が走らせる。`lint:code` + `typecheck` + `test`。`lint:actions` を含まないのは、CI workflow が `actionlint` / `zizmor` を action wrapper 経由 (= バイナリの supply chain を action 側に委譲) で走らせて重複監査を避けるため
  - `ci`: ローカル/lefthook が走らせる。`lint` (= `lint:code` + `lint:actions`) + `typecheck` + `test`。ローカルでは PATH の actionlint/zizmor バイナリを直接実行する
- ローカル / lefthook: `actionlint` と `zizmor` は **PATH のバイナリ直接実行**:
  - Windows: `scoop install actionlint zizmor`
  - macOS: `brew install actionlint zizmor`
  - Linux: バイナリリリースを `~/.local/bin` 等に配置
- CI: `raven-actions/actionlint` と `zizmorcore/zizmor-action` を SHA pin で呼出 (バイナリインストール込み)

ローカル `bun run ci` のカバレッジ = (CI workflow の wrapper action 監査 + `bun run check`) のカバレッジ。**実行ホストだけ違う**。

`scripts/check-pins.sh` は SHA / version プレースホルダや tag 参照を検出する保護スクリプト (§14 末尾参照)。CI に組み込む。

---

## 5. lefthook 設定 (`lefthook.yml`)

参照: `9c5s/node-tcnet/lefthook.yml` のパターン。

```yaml
colors: false
no_tty: true
glob_matcher: doublestar

pre-commit:
  parallel: true
  jobs:
    # ガード
    - name: protect-branch
      run: >
        d=$(git symbolic-ref --quiet --short
        refs/remotes/origin/HEAD 2>/dev/null|sed 's#^origin/##');
        d=${d:-main};
        [ $(git rev-parse --abbrev-ref HEAD) != $d ] ||
        { echo Direct commits to $d are not allowed.&& exit 1; }

    - name: ignored-files
      run: "! git check-ignore {staged_files}"

    # コードスタイル: format → lint 逐次 (Biome 1 本)
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

    # GitHub Actions 監査: zizmor --fix → actionlint 逐次 (PATH バイナリ直接呼出)
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

    # メタ
    - name: lefthook-validate
      glob: lefthook.yml
      run: bunx lefthook validate

commit-msg:
  jobs:
    - name: commitlint
      run: bunx commitlint --edit {1}
```

- **`actionlint` / `zizmor` は `bunx` を使わず直接実行**。`scoop install actionlint zizmor` (または OS 別の同等手段) で PATH に配置する前提
- pre-commit が遅くなった場合は `test` を `pre-push` に降ろす
- markdownlint / textlint は今回は未採用 (個人 bot で docs ボリュームが小さいため YAGNI)

---

## 6. commitlint 設定 (`commitlint.config.ts`)

参照: `9c5s/tcnet-viewer/commitlint.config.ts` をそのまま採用。

```ts
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "subject-case": [0],          // 件名の大文字小文字は問わない
    "scope-empty": [2, "always"], // scope は必ず空 (例: feat: ... 可 / feat(api): ... 不可)
  },
};
```

CLAUDE.md の Conventional Commits 規約と整合する。Bun は `.ts` 設定を `bunx commitlint` から直接読み込める。

---

## 7. GitHub Actions ワークフロー (`.github/workflows/ci.yml`)

参照: `9c5s/node-tcnet/.github/workflows/ci.yml` のセキュリティパターン + Codex round 1/2 指摘の `defaults.run.shell` / `set -euo pipefail` / zizmor-action の `advanced-security: false` を反映。

```yaml
name: CI
on:
  workflow_dispatch:
  pull_request:
  push:
    branches: [main]

permissions: {} # deny-all、job ごとに最小権限で grant

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
      contents: read # リポジトリのチェックアウトに必要
    steps:
      - name: Checkout repository
        uses: actions/checkout@<SHA> # v6.0.2 など実装時に最新を SHA pin
        with:
          persist-credentials: false
          fetch-depth: 1

      - name: Setup Bun
        uses: oven-sh/setup-bun@<SHA> # vX.Y.Z 実装時に SHA pin
        with:
          bun-version: <BUN_VERSION_PIN> # 例: 1.2.20、`packageManager` と完全一致

      - name: Install dependencies
        run: |
          set -euo pipefail
          bun install --frozen-lockfile --ignore-scripts

      - name: Check pin placeholders
        run: |
          set -euo pipefail
          bun run check-pins

      - name: actionlint
        uses: raven-actions/actionlint@<SHA> # vX.Y.Z 実装時に SHA pin
        with:
          version: <ACTIONLINT_VERSION_PIN> # 例: 1.7.7、action のラップする actionlint binary を pin
          shellcheck: false # action が brew/apt/choco で shellcheck を追加 install する挙動を抑止
          pyflakes: false   # 同じく pyflakes の追加 install を抑止 (workflow に Python はない)
          cache: false      # binary キャッシュを無効化、毎回固定 version を fetch (drift と cache-poisoning を回避)
          github-token: ""  # 新しい input 名、空文字で無効化
          token: ""         # legacy input 名、action.yml が `inputs.github-token || inputs.token || env.GITHUB_TOKEN` の順で fallback するため両方明示的に空にして token 露出を最小化
          # 注意 (HYPOTHESIS、要初回 CI 検証): 内部の actions/github-script が GitHub Releases API で actionlint binary を解決する処理を unauthenticated で叩くため、anonymous rate limit (60 req/hour/IP) に当たる、または空 token の handling で失敗する可能性がある。初回 CI で失敗を観測した場合の選択肢: (a) `github-token` のみ空文字を撤回して `contents: read` の `github.token` 利用を受容、(b) 別の固定 binary install 手順 (cache: false なので毎回 download、scoop 風の手動 install を action 外で行う) に切替。初回数回の CI 安定性を観察して判断する
          # 残リスク (記録): action.yml 内部で `npm install --no-save @actions/tool-cache@3.0.1` を実行する経路があり、wrapper action 経由の supply-chain には未 pin の npm download が含まれる。SHA pin + binary version pin だけでは完全に塞げない攻撃面。代替策として action wrapper をやめ、checksum 検証付きの固定 binary install (`gh release download` + `sha256sum`) に切り替える選択肢がある。本仕様では初期は wrapper action を使い、CI 安定性が確認できたら手動 install への切替を検討する

      - name: zizmor (pedantic)
        uses: zizmorcore/zizmor-action@<SHA> # vX.Y.Z 実装時に SHA pin
        with:
          version: <ZIZMOR_VERSION_PIN> # 例: 1.7.0、action のラップする zizmor binary を pin
          persona: pedantic
          advanced-security: false # findings をジョブ失敗として扱う (Advanced Security mode を無効にする)
          online-audits: false      # GitHub API 経由の online audit を無効化、`actions: read` 等の追加権限を不要にする (覆える audit を犠牲にしてもパーミッションを最小化する判断)
          token: ""                 # online-audits: false でも action は GHA_ZIZMOR_TOKEN に github.token を渡す挙動があるため、空文字で明示的に無効化 (検証済み: https://raw.githubusercontent.com/zizmorcore/zizmor-action/main/action.yml)

      - name: App check (lint:code / typecheck / test)
        run: bun run check
```

採用パターン:

- `permissions: {}` を workflow top-level (deny-all)
- `defaults.run.shell: bash` を top-level に置き、`run:` は明示シェルで実行 (zizmor pedantic の `unpinned-shell` / pipefail ポリシー対応)
- 複数行 `run:` の先頭で `set -euo pipefail` を明示
- job 単位で `contents: read` のみ最小付与、各 permission に日本語コメントで理由
- 全 third-party action を SHA pin + `# vX.Y.Z` コメント (dependabot で追従、補助で `pinact` も検討)
- `actions/checkout` に `persist-credentials: false` + `fetch-depth: 1`
- `concurrency` で同一 ref の古い run を cancel
- `workflow_dispatch` で手動リトライ可能
- 失敗の早期検出のため `check-pins` → actions 監査 (actionlint → zizmor) をアプリ CI より前に走らせる
- アプリ check には `bun run check` を呼ぶ (`ci` は呼ばない。`lint:actions` の CLI 重複は wrapper action と二重監査になるため)
- **Bun version は `setup-bun` の `bun-version` と `package.json` の `packageManager` で値を一致させる**
- **zizmor-action の `advanced-security: false` + `online-audits: false`**:
  - zizmor-action は **既定で `advanced-security: true`** であり、その状態では「findings が出ても job は fail しない」(GitHub Advanced Security 連携 UI に結果を投稿するだけ) ことが README で明示されている (検証済み: https://github.com/zizmorcore/zizmor-action)。本リポジトリは Advanced Security を使わず、findings を CI 失敗として扱いたいので `advanced-security: false` を明示する
  - 同 README は private repo + `advanced-security: true` で `actions: read` 権限が必要と記す。本仕様は `advanced-security: false` を採用するため `actions: read` 追加は不要。代わりに `online-audits: false` も明示することで、GitHub API への外向き query を全部止めパーミッションの最小化を確実にする (online-only audit が走らないことを意図的に許容するトレードオフ)
- **actionlint / zizmor の binary version pin**: `raven-actions/actionlint` と `zizmorcore/zizmor-action` はどちらも `version` input に既定で `latest` を取り、内部で wrap する binary が drift する。`<ACTIONLINT_VERSION_PIN>` / `<ZIZMOR_VERSION_PIN>` で binary 自体を pin する

実装時の SHA / version 置換チェックリストは §14 末尾参照。

---

## 8. Workers Builds 設定 (Cloudflare ダッシュボード)

`Workers & Pages → stamina-reminder → Settings → Build` で設定:

- **Git repository**: `9c5s/stamina-reminder` (GitHub と OAuth 連携)
- **Production branch**: `main`
- **Build command**: `bun install --frozen-lockfile --ignore-scripts`
- **Deploy command**: `bun run deploy`
- **Root directory**: `/`
- **Non-production branch builds**: **無効** (preview ビルドで Secret が露出するリスクを回避。チームでなく 1 人運用のため preview の利点も薄い)
- `--ignore-scripts` の意図: Bun は **既定で依存パッケージの lifecycle script を実行しない** (`https://bun.com/docs/pm/cli/install` で明示、検証済み)。よって「依存の postinstall が env を読む」攻撃面は Bun のデフォルトで既に塞がっている。`--ignore-scripts` で追加抑止するのは **root package (本リポジトリ自身) の lifecycle script** の実行のみ。本リポジトリは `package.json` の `scripts` に preinstall/postinstall 系を **意図的に置かない方針** を明文化し、`--ignore-scripts` を belt-and-suspenders として CI/Workers Builds 双方で同じ install フラグに揃える。仮に将来「特定の依存パッケージの install script を信頼して動かす」必要が出たら、Bun の `package.json` で `trustedDependencies` 配列に当該パッケージ名を明示してから `--ignore-scripts` を残したまま `bun install --trust` 等で個別実行する (詳細は §14)

**Workers Builds の Build Secrets は意図的にゼロ件**にする。Cloudflare 公式 docs は Workers Builds の Build Variables / Build Secrets が build command と deploy command の間で step 単位に scope されるかどうかを明示していない (2026-06 時点)。明示が無い以上、**同一ビルドプロセス内では env var として常時露出している前提**で扱うのが安全側。攻撃面の主たる懸念は (1) 本リポジトリの **root package の lifecycle script** (`scripts.preinstall` / `scripts.postinstall` 等) を介して Build 環境内の env を読まれること、(2) `deploy command` 中に走る `wrangler` 自体や Bun ランタイムが env を参照する設計の Bug。Bun は依存パッケージの lifecycle script は default で実行しないため、従来 npm 系で懸念された依存経由の攻撃面は閉じている (§14 参照)。にもかかわらず本仕様で `DISCORD_BOT_TOKEN` を Build Secret に置かないのは、deploy command 中の `wrangler` プロセスや root スクリプトに **不要に token を露出させない最小特権原則**による。register-commands は Workers Builds に同居させず、ローカル手動運用に移す (§13 参照)。将来 CF が step-scoped secret を明文化したら本仕様を再評価する。

Bun の version pin (Workers Builds 側):

- `Settings → Variables and Secrets → Build Variables and Secrets` に `BUN_VERSION` を **Plain text** で **`<BUN_VERSION_PIN>` (例: 1.2.20)** として登録 ([Workers Builds Build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/) のドキュメントに従う)
- これにより Workers Builds が build image の Bun を当該 version に切り替える
- `curl | bash` 等のフォールバック install は採用しない (build 環境内の version drift / supply chain リスクを招く)

自動 inject される環境変数 (参考):
- `CI=true`
- `WORKERS_CI=1`
- `WORKERS_CI_BUILD_UUID`
- `WORKERS_CI_COMMIT_SHA`
- `WORKERS_CI_BRANCH`

### Workers Builds への API Token (auto-generated を使わない)

OAuth 連携時に Cloudflare が自動生成する API Token は権限が広い (アカウント全体の Worker 編集権限を含むことがある)。本プロジェクトでは **custom API Token を発行して紐付ける**:

- Account → **Workers Scripts: Edit**
- Account → **Workers KV Storage: Read** (`wrangler deploy` は binding の存在検証のみで KV namespace の create / write は行わないため Read で十分。namespace 作成はローカル `wrangler kv namespace create` (OAuth セッション) で実施)
- Account → **Account Settings: Read** (whoami / アカウント識別に必要)
- Account → **User Details: Read**
- 対象 Account は `b40fdc1cf09112832597f6e05f829cae` (9c5s) のみに限定発行

dashboard の `Workers & Pages → Project → Settings → Build → API Token` から既存 token を差し替える。auto-generated を残したまま運用しない。

参考: [Workers Builds Configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [Workers Builds Build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)。

---

## 9. Secrets と環境変数の運用

Cloudflare Runtime secrets に集約。GitHub には Cloudflare/Discord の secret を置かない。Workers Builds にも Discord 系 secret を置かない (ライフサイクル script 経由の漏洩対策、§8 参照)。ローカル開発の env ファイルは **`.dev.vars` に統一**する。

> 注: 現状の `docs/architecture.md` は `register-commands.ts` のローカル実行に `dotenv/config` + `.env` + `npx tsx` を使う前提で書かれている。本仕様は `.dev.vars` + Bun ネイティブ実行 (`bun scripts/register-commands.ts`) に統一する。`architecture.md` および `HANDOFF.md` の該当箇所はこの仕様の確定後に同じコミットラインで合わせて書き換える (後述 §12 step 8、register-commands 周辺だけでなく wrangler.toml / secrets / install フラグ / setup 順序を含む全体同期)。

### Cloudflare Worker Runtime secrets

`Settings → Variables and Secrets → Runtime variables and secrets` または `wrangler secret put <NAME>` で投入:

| 名前 | 種類 | 用途 |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Secret | UserState DO の alarm() から通知 REST POST |

`DISCORD_APPLICATION_ID` と **`DISCORD_PUBLIC_KEY`** は秘密ではない (PUBLIC_KEY は Ed25519 検証用の **公開鍵** であり、Discord Developer Portal にも明示されている)。`wrangler.toml` の `[vars]` で宣言する:

```toml
[vars]
DISCORD_APPLICATION_ID = "<APPLICATION_ID>"
DISCORD_PUBLIC_KEY = "<PUBLIC_KEY>"
```

ランタイム secret 表には載せない (Runtime UI で `vars` と secret を混ぜると整合性検証 (`wrangler types` の `secrets.required`) で齟齬が出る)。PUBLIC_KEY を Secret 扱いにしてしまうと、setup 初期に「Worker を一度 deploy → `wrangler secret put` で新 version + 即 deploy」という out-of-band な手順を強いることになり (CF docs: `wrangler secret put` は即時 deploy を作る、https://developers.cloudflare.com/workers/configuration/secrets/)、本質的に公開可能な情報を Secret に置く必要がないため `[vars]` に統一する。

### Cloudflare Workers Builds の Build Variables and Secrets

`Settings → Variables and Secrets → Build Variables and Secrets`:

| 名前 | 種類 | 用途 |
|---|---|---|
| `BUN_VERSION` | Plain text | build image の Bun version pin |
| `SKIP_DEPENDENCY_INSTALL` | Plain text (`1`) | Workers Builds 標準の自動依存 install を無効化 (本仕様は custom build command で `bun install --ignore-scripts` を明示するため、CF 側の自動 install と重複しないようにする) |

**Discord 系の secret は置かない** (上記の理由)。

### ローカル開発用 (`.dev.vars`)

`.gitignore` 対象。`wrangler dev` 起動時に `wrangler` が自動ロード、`bun scripts/register-commands.ts` も同ファイルを読み込む統一実装にする:

```
DISCORD_PUBLIC_KEY=xxx
DISCORD_BOT_TOKEN=xxx
DISCORD_APPLICATION_ID=xxx
# 任意: 開発中の guild scope 登録に使う、未設定なら register-commands.ts は global コマンド登録に fallback
# DISCORD_GUILD_ID=xxx
```

スクリプト側 (`scripts/register-commands.ts`) は **本プロジェクト専用の `KEY=VALUE` subset** を Bun の `Bun.file('.dev.vars').text()` で読み込む。完全な dotenv 仕様 (inline comment、エスケープ、複数行値、変数展開) はサポートしない。`.dev.vars` ファイル自体は CF の dotenv フォーマット (`KEY=VALUE` 1 行 1 ペア + 行頭 `#` のコメント + 値のクォート) に従って書くが、本プロジェクトで扱うキー (`DISCORD_APPLICATION_ID` / `DISCORD_PUBLIC_KEY` / `DISCORD_BOT_TOKEN` + optional `DISCORD_GUILD_ID`、いずれもシンプルな ASCII 値) は以下の最小 parser で十分:

```ts
// scripts/register-commands.ts 抜粋
const text = await Bun.file('.dev.vars').text();
const env = Object.fromEntries(
  text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const [k, ...v] = line.split('=');
      return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')];
    })
);
const appId = env.DISCORD_APPLICATION_ID;
const token = env.DISCORD_BOT_TOKEN;
const guildId = env.DISCORD_GUILD_ID; // optional、設定されていれば guild scope へ登録、未設定なら global コマンド登録に fallback
```

- 値のクォート (`"..."` / `'...'`) を strip
- `#` で始まる行はコメントとして無視
- 空行は無視

`dotenv` パッケージや `process.env` 経由は使わない (二重管理を避け、Bun ネイティブ実行に揃える)。

### GitHub Repository Secrets

**なし**。`check` job は secret を一切要求しない。

### 漏洩時の対応

- **Discord Bot Token**: Discord Developer Portal で `Reset Token` → 即時無効化 → Cloudflare Runtime secret (`wrangler secret put DISCORD_BOT_TOKEN`) を更新。ローカル `.dev.vars` も更新し、`bun run register-commands` を再実行 (新 token で REST 認証)。
- **Cloudflare API Token (Workers Builds 用)**: Cloudflare dash の API Tokens で当該 token を `Roll` → 同等スコープで再発行 → Workers Builds の `Settings → Build → API Token` で差し替え。
- **Cloudflare account**: ダッシュボードでセッションを revoke。OAuth 連携も解除して再連携。

---

## 10. ブランチ保護とリポジトリ設定

### `main` ブランチ保護 (`Settings → Branches`)

- Require a pull request before merging: **オン**
  - Required approvals: **0** (1 人作業のため、増員時に 1 へ)
- Require status checks to pass before merging: **オン**
  - Required check: `Check` (`.github/workflows/ci.yml` の `check` job)
- Require linear history: **オン**
- Do not allow bypassing the above settings: **オン**
- Allow force pushes: **オフ**
- Allow deletions: **オフ**

### リポジトリ一般設定 (`Settings → General`)

- Default branch: `main`
- Pull Requests:
  - Allow merge commits: **オフ**
  - Allow squash merging: **オフ**
  - Allow rebase merging: **オン** (これのみ)
  - Automatically delete head branches: **オン**
- Features:
  - Wiki: **オフ**
  - Discussions: **オフ**
  - Issues: **オン** (バグ・タスク追跡用)

---

## 11. dependabot 設定 (`.github/dependabot.yml`)

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
  - package-ecosystem: bun # Bun の lockfile (`bun.lock`) を Dependabot に正しく更新させる。`npm` ecosystem だと bun.lock 検出 / 更新が drift する。GitHub の一次資料は 2 ページに分かれる: `package-ecosystem: bun` の使用可否と最小バージョン (>=v1.2.5) は dependabot-options-reference (https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)、`bun.lock` 互換性 (>=v1.1.39) は supported-ecosystems-and-repositories (https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories) を参照
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 7
    groups:
      # bun ecosystem は `dependency-type` グルーピングを公式サポートしていない (bundler/composer/mix/maven/npm/pip のみ)。代わりに `patterns: ["*"]` で 1 グループに集約して週次 PR を 1 本にまとめる。根拠: https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference
      bun:
        patterns: ["*"]
```

- **`cooldown: { default-days: 7 }`** を全 updater に付ける (zizmor pedantic の `dependabot-cooldown` 監査対応)
- `groups` で関連 PR をまとめてレビュー負荷を低減
- lefthook の `ci-lint` job が `.github/dependabot.yml` も対象にしているため、保存時に zizmor がチェックする

### SHA pin の更新運用

Dependabot は [SHA pin に `# v1.2.3` のコメントが添えられている場合に、新タグの SHA へ書き換える](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference) ことができる。Codex 指摘 (HYPOTHESIS) のとおり、tag → SHA 解決の動作は構成依存であり、想定通り動かないケースがある。

そこで補助手段:

- 初回セットアップ後に **`pinact` または `frizbee`** をローカルで実行して全 action を最新 SHA に強制リフレッシュできる体制を組む (CLI を Makefile / package.json script に登録するのは将来検討)
- Dependabot の挙動を初回 PR で実地検証し、SHA が動かなければ Renovate への切替えを検討
- `bun run check-pins` を CI ステップに組み込み、`<SHA>` プレースホルダや非 SHA な `uses:` 参照 (`@v4` 等) が残っていないことを検出 (§14 末尾参照)

---

## 12. 初回 setup 手順

順序が重要。**`bun install` は `bunx wrangler ...` を含むすべての CLI コマンドより前**、`wrangler.toml` の整備は **初回 deploy より前**に必ず実施する。

1. GitHub リポジトリ作成 (`9c5s/stamina-reminder`、Public)
2. ローカルから空 commit を push して `main` を作成
3. **branch protection / repo settings の前段**: §10 のうち以下のみ先に設定する:
   - Pull Request 必須 (Required approvals: 0)
   - Require linear history: オン
   - Allow force pushes / deletions: オフ
   - merge 設定 (rebase only)、Wiki / Discussions: オフ
   - **Require status checks to pass before merging はまだ設定しない** (チェック名 `Check` は workflow が一度走るまで GitHub UI で選択肢に出ないため)
4. Discord Developer Portal で Application / Bot を作成 (`HANDOFF.md` Phase 1 参照)、以下 3 つを控える:
   - `DISCORD_APPLICATION_ID` (Plain text、`wrangler.toml [vars]` および `.dev.vars` に書く)
   - `DISCORD_PUBLIC_KEY` (Plain text、Ed25519 公開鍵なので Secret 扱いしない。`wrangler.toml [vars]` および `.dev.vars` に書く)
   - `DISCORD_BOT_TOKEN` (Cloudflare Runtime secret と `.dev.vars` に書く)
5. **ローカル前提の確認**: Windows なら Git Bash (lefthook の POSIX シェル前提に必要)、macOS / Linux は標準シェルでよい。`actionlint` と `zizmor` を PATH にインストール (`scoop install actionlint zizmor` 等、§4 参照)
6. ローカルでプロジェクト雛形作成 (`bun create hono` 等) → `package.json` を §4 の構成に整える (`packageManager`, `devDependencies`, `scripts`)
7. **初回 bootstrap install** をローカルで実行 → `bun.lock` を生成 → `bun.lock` を commit。初回は lockfile がまだ無いので `bun install --ignore-scripts` (`--frozen-lockfile` を付けない) で生成する。以後の CI / Workers Builds / ローカル検証は `bun install --frozen-lockfile --ignore-scripts` を使う (= §4 末尾の方針)
8. **`HANDOFF.md` と `docs/architecture.md` を本仕様に同期**: 旧文書には本仕様と矛盾する記述が残る (npm / npx / `.env` / `dotenv/config` / `DISCORD_PUBLIC_KEY` を secret 投入する流れ / package manager の前提など)。以下を本仕様に合わせて書き換えるか、書き換えが大きすぎる場合は冒頭に「本ファイルは superseded by `docs/superpowers/specs/2026-06-29-github-cicd-design.md` (CI/CD 部分について)」と明記してから新規読者が本仕様を参照する誘導を入れる:
   - `register-commands` 周辺: `.dev.vars` + `bun scripts/register-commands.ts` (旧: `.env` + `npx tsx` + `dotenv/config`)
   - `wrangler.toml` の `[vars]` に `DISCORD_PUBLIC_KEY` を入れる (旧: secret として `wrangler secret put DISCORD_PUBLIC_KEY` する案を撤回)
   - secrets 一覧: Runtime secret は `DISCORD_BOT_TOKEN` のみ
   - package manager / install: Bun + `bun install --frozen-lockfile --ignore-scripts` 統一
   - setup の順序: 本仕様 §12 のフェーズ分割 (PING/PONG → Endpoint URL → Phase 2 → BOT_TOKEN → register) を反映
   - 同コミットラインで反映する
9. **CI/lint 関連の config ファイル群を materialize**:
   - `.github/workflows/ci.yml` (§7)
   - `.github/dependabot.yml` (§11)
   - `lefthook.yml` (§5)
   - `commitlint.config.ts` (§6)
   - `biome.json` (Biome の default 設定でも可)
   - `tsconfig.json` (Hono / Workers 向け)
   - `vitest.config.ts` (純粋ユニットスコープ、§14)
   - `scripts/check-pins.sh` (§14 末尾の実装イメージ)
   - `package.json` の `scripts` を §4 のとおり
   - この時点で `<SHA>` 等のプレースホルダは未解決なので、§14 末尾の置換チェックリストに従い実値に差し替えてから次へ進む (本仕様の `docs/` 配下は check-pins.sh の scan 対象外)
10. `bunx lefthook install` で hooks を有効化、**`bun run check`** がローカルで通ることを確認 (この段階では `bun run ci` ではなく `bun run check` を使う。`ci` は `lint:actions` を含むためローカル PATH の `actionlint`/`zizmor` を呼ぶが、CI workflow の `check` job は wrapper action 経由で別途監査するため、まずは `check` の通過を持って先へ進む。`bun run ci` は §14 のチェックリストが green になってからローカル運用に組み込む)
11. **Cloudflare 認証をローカルで設定**:
    - 対話運用: `bunx wrangler login` (OAuth、9c5s アカウントで承認)
    - 非対話運用: `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を環境変数で設定
    - 確認: `bunx wrangler whoami`
12. **`wrangler.toml` を整備 (第 1 段階用、DO は除外)**:
    - `name = "stamina-reminder"`
    - `main = "src/index.ts"`
    - `compatibility_date = "<実装日 YYYY-MM-DD>"`
    - `compatibility_flags = ["nodejs_compat"]` (必要に応じて)
    - `preview_urls = false` (preview ビルド無効化と整合)
    - `account_id = "b40fdc1cf09112832597f6e05f829cae"` (明示しておくと `wrangler` が複数アカウントから迷わない)
    - `[vars] DISCORD_APPLICATION_ID = "<APPLICATION_ID>"` と `[vars] DISCORD_PUBLIC_KEY = "<PUBLIC_KEY>"` を併記 (PUBLIC_KEY は公開鍵なので Secret にしない、§9 参照)
    - KV 作成: `bunx wrangler kv namespace create TITLES` → 出力 `id` を `[[kv_namespaces]]` に書く
    - **Durable Object binding と `[[migrations]]` はこの段階では入れない** (`UserState` class を export しない最小 Worker で migration を含めると deploy が fail する。第 2 段階 step 22 で UserState 実装後にまとめて追加する)
    - 詳細は `docs/architecture.md` §7 を参照する (step 8 で同期 / superseded note を入れた前提)。superseded note のまま運用する場合は本仕様の §3 / §8 / §9 / §12 を一次資料として優先する
13. Cloudflare で **custom API Token を発行** (§8 のスコープ)
14. Cloudflare Workers Builds で GitHub と OAuth 連携 → `Settings → Build → API Token` で発行した custom token に差し替え
15. Build/Deploy command と Production branch、Non-production branch builds = 無効を本書 §8 に従って設定
16. Workers Builds の Build Variables に **`BUN_VERSION` (Plain text) と `SKIP_DEPENDENCY_INSTALL=1` (Plain text) を登録** (Discord 系 Secret は登録しない)
17. `.dev.vars` をローカルに作成 (`.gitignore` 済みであることを確認、本仕様 §9 の `KEY=VALUE` subset に従う)
18. **第 1 段階デプロイ (PING/PONG のみ)**: `src/index.ts` を「Ed25519 verify (`env.DISCORD_PUBLIC_KEY` を `[vars]` から読む) + PING/PONG だけ返す」最小実装で `main` への初回 PR を作成 → GitHub Actions `check` job が green を確認 → rebase merge → Workers Builds が自動 deploy。`DISCORD_PUBLIC_KEY` は `[vars]` 経由で Worker に届いているため Ed25519 verify は最初の deploy から機能する
19. **GitHub branch protection の後段**: step 18 の CI が一度走ったため、`Settings → Branches` の `main` 設定に戻り、`Require status checks to pass before merging` を有効化し、`Check` を required check に追加する (代替: GitHub Rulesets ならチェック名を先に文字列で指定可能、Phase 2 で検討)
20. **Discord Interactions Endpoint URL の設定**: Worker URL (`https://stamina-reminder.<subdomain>.workers.dev/interactions`) を Discord Developer Portal の `General Information → Interactions Endpoint URL` に登録 → Discord が署名付き PING を投げ、Worker が Ed25519 verify → `type: 1 (PONG)` を 200 で返却 → 登録完了 (= 第 1 段階の動作確認 = PING/PONG ハンドリングのみ)
21. **第 2 段階実装**: `/stamina add` / `/stamina list` / `/stamina cancel` / `/title add` / `/title list` / `/title remove` の handler、UserState DO クラスの実装、KV ラッパなどを書く。`wrangler.toml` に以下を追加:
    - `[[durable_objects.bindings]] name = "USER_STATE" class_name = "UserState"`
    - `[[migrations]] tag = "v1" new_sqlite_classes = ["UserState"]`
    - PR → merge → Workers Builds 自動 deploy。**この migration を境に、migration 前の version への rollback は CF 公式仕様により不可能になる** (migration 後同士の rollback は §13 / §14 の制約に従う)、検証は丁寧に
22. **`DISCORD_BOT_TOKEN` を投入**: Phase 2 で alarm() からの通知 REST が走るために必要。`bunx wrangler secret put DISCORD_BOT_TOKEN` で新 version 作成 + 即 deploy ([wrangler secret put 仕様](https://developers.cloudflare.com/workers/configuration/secrets/) 参照、即時 production deploy として扱われる)。step 21 の Phase 2 deploy 完了後に投入することで Phase 1 期間中の不要な token 露出を避ける (最小特権原則)。投入直後は **§13.3 Stage 1 範囲 (Worker URL 起動 / PING / tail エラーなし) の sanity check に限定** する。slash コマンド smoke (Stage 2) は次の step 23 でコマンド登録を済ませてから step 24 で実施
23. **コマンド登録**: ローカルから `bun run register-commands` を実行 (`.dev.vars` を読む) → Discord 側のコマンド一覧が更新される (global コマンドは伝搬最大 1 時間)
24. **§13.3 Stage 2 の post-deploy 検証** (slash コマンドの smoke test を含む) を実施。Stage 1 (= step 20 終了時点) では Endpoint URL 登録の成功をもって動作確認とし、`/stamina list` 等の検証はここまで完了してから意味を持つ

---

## 13. 運用フロー

### 通常開発

1. `feat/xxx` ブランチを切る
2. ローカルで実装、`bun run ci` でグリーンを確認
3. commit (lefthook が走る)、PR 作成
4. GitHub Actions `check` が PR で実行
5. Approve → `main` へ rebase merge
6. Workers Builds が production deploy
7. **§13.3 (post-deploy 検証)** を実施

### Slash コマンド定義変更時

`src/commands.ts` を変更したコミットを `main` に merge して deploy が完了した後、**ローカルから `bun run register-commands` を手動実行**する (Workers Builds 側では走らせない設計、§8 参照)。

- ローカルに最新の `main` を pull
- `.dev.vars` に `DISCORD_BOT_TOKEN` と `DISCORD_APPLICATION_ID` が入っていることを確認
- `bun run register-commands` を実行
- 出力ステータスを目視確認、Discord 側で実コマンドが表示されることを確認 (global コマンドは伝搬最大 1 時間)

開発中に短サイクルで試したい場合は guild コマンド (`DISCORD_GUILD_ID` を一時的に追加して guild scope に登録するスクリプト) を補助で使う。

### Post-deploy 検証 (毎デプロイ実施、Stage によって対象が違う)

**Stage 1 (PING/PONG のみのデプロイ、§12 step 18-20 完了時点。step 22 の `DISCORD_BOT_TOKEN` 投入直後の sanity check もここに含める)**:

1. **Workers Builds のビルドログ確認**: deploy が success で終了しているか、CF dashboard `Workers & Pages → Project → Deployments` で確認
2. **Worker Logs (`wrangler tail`)** をローカルで起動:

   ```sh
   bunx wrangler tail stamina-reminder --format pretty
   ```

3. **PING 検証**: Discord Developer Portal で Interactions Endpoint URL の登録 / 再登録を試み、Discord 側に「登録成功」と表示されることを確認 (= Worker が署名検証 + PONG 返却に成功)
4. tail に Ed25519 関連 error が出ていないことを確認

**Stage 2 以降 (UserState DO + slash command handler が乗ったデプロイで、かつ `bun run register-commands` 実行済みの状態、§12 step 23-24 完了後)**:

上記 Stage 1 の項目に加えて以下を実施:

5. **Smoke test (slash command)**: Discord で `/stamina list` を叩き、200 応答 + 期待文言が返ることを確認 (空の場合は空文言)
6. **通知パスの確認** (任意): `/stamina add` で短時間 (60 秒等) で満タンになる値を登録し、alarm() 経由で実通知が来ることを確認
7. **Alarm 失敗監視**: `wrangler tail` のログに `alarm` レベルの error が流れていないかを次回開発時にもう一度確認 (DO の at-least-once 再試行は最大 6 回まで)
8. **Discord REST 429** が頻発していないか tail で確認 (発生していれば setAlarm の再キューを観測)

### Secret 更新

`wrangler secret put <NAME>` は **新しい Worker version を作成して即時 production deploy する**仕様 (CF 公式: https://developers.cloudflare.com/workers/configuration/secrets/)。よって以下はすべて **production deploy として扱う**:

- 通常運用: `bunx wrangler secret put <NAME>` 実行 → 即 deploy → 直後に **§13.3 Stage 2 検証を必須実施** (PING + slash command smoke + tail)
- より慎重に運用したい場合 (新 version を作成して traffic 切替は段階的に行う): `bunx wrangler versions secret put <NAME>` で新 version だけ作成 → `bunx wrangler versions deploy <NEW_VERSION_ID>@10% <CURRENT_VERSION_ID>@90% -y` のように traffic を段階的に切り替える ([wrangler versions deploy 仕様](https://developers.cloudflare.com/workers/wrangler/commands/workers/) 参照、`-y` で対話プロンプトをスキップ、percentage の合計 100% で配分)。問題なければ次回 `100% / 0%` で完全切替

Workers Builds Build Variables (`BUN_VERSION` と `SKIP_DEPENDENCY_INSTALL` のみ): CF dashboard で書き換え後、自動 deploy は走らないため、次の `main` push で反映される。即時反映が必要なら手動 `Workers & Pages → Project → Deployments → Retry build` で deploy をトリガーする。

### Rollback (デプロイ失敗時)

`wrangler` には直近 100 バージョンの履歴があり、`wrangler rollback` で復旧可能:

```sh
# 直前のバージョンに戻す
bunx wrangler rollback --name stamina-reminder --message "revert bad deploy"

# 特定 version を指定して戻す
bunx wrangler versions list --name stamina-reminder
bunx wrangler rollback <VERSION_ID> --name stamina-reminder --message "<reason>"
```

または Cloudflare dashboard の `Workers & Pages → Project → Deployments` で過去バージョンを `Promote` する。

**DO migration を含むデプロイ後の rollback の制約**: Cloudflare 公式 rollback ドキュメント (https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/) が、「アクティブな deployment と rollback 先 version の間で Durable Object migration が発生した場合、rollback は許可されない」と明示している。つまり `[[migrations]]` を新たに含む deployment を行うと、それより前の version への `wrangler rollback` や dashboard rollback はブロックされる (`new_sqlite_classes` 追加であっても同様に migration として扱われる)。

migration を含むデプロイで問題が出た場合は rollback 不可と前提し、**前方修正 (新たな fix デプロイ)** で対応する。`bun run register-commands` の失敗は migration とは独立なので、コマンド登録の不整合は単独で再実行で復旧可能。

`register-commands` が失敗した場合 (Worker は deploy 済み、Discord 側だけ未反映):

```sh
# ローカルから再実行 (.dev.vars 経由)
bun run register-commands
```

---

## 14. リスク・補足

- **Cloudflare OIDC 非対応**: wrangler deploy 認証に GitHub OIDC を使う公式パスは存在しない (2026-06 時点)。Workers Builds への移行で問題を回避。
- **Workers Builds の Bun 対応**: build image に Bun が preinstall されている前提で `BUN_VERSION` 環境変数で固定する。`curl | bash` 経由のフォールバック install は採用しない (build 環境内の version drift / Secret 露出を招くため)。Bun が build image から外された場合は本仕様を見直す。
- **Build Secret の install lifecycle 露出**: Bun は依存パッケージの postinstall 等を **既定で実行しない** (検証済み: https://bun.com/docs/pm/cli/install)。したがって従来の npm/yarn 系で問題になる「依存の postinstall が env を読む」攻撃面は Bun のデフォルトで既に塞がっている。本仕様では追加防御として (1) Discord 系 secret を Workers Builds から外し register-commands はローカル手動運用 (§8, §13)、(2) Build/CI command を `bun install --frozen-lockfile --ignore-scripts` に統一し **root package の lifecycle script** も抑止 (本リポジトリに preinstall/postinstall を意図的に置かない方針と整合)、(3) `SKIP_DEPENDENCY_INSTALL=1` で CF 側の自動 install と二重実行されないようにする。CI と Workers Builds で同一の install フラグを使うため、ローカル/CI/Builds で挙動が drift しない (= Major round 4 指摘の解消)。仮に特定依存の install script を信頼して動かす必要が出たら、`package.json` の `trustedDependencies` 配列にパッケージ名を明示してから `bun install --trust` で個別解除する (`--allow-scripts` は npm の概念で Bun では使わない)。残る攻撃面: Workers Builds が deploy 時に `CLOUDFLARE_API_TOKEN` を env var に置く場合 (CF 公式に明文化なし)、deploy command 内で動く `wrangler` から token は見える。これは `wrangler` 自身が信頼境界となるため、`wrangler` の devDependency pin + bun.lock + ignore-scripts が前提崩れを抑える。初回 deploy で `bun install --frozen-lockfile --ignore-scripts` のまま `wrangler deploy` が成功するかを実地検証する (失敗したら `trustedDependencies` への明示 opt-in で限定解除)。bootstrap 時 (lockfile 未生成時) だけは `--frozen-lockfile` を外し `bun install --ignore-scripts` で lockfile を生成する (§4 / §12 step 7 と一致)。
- **DO migration を含むデプロイ後の rollback はブロックされる (CF 公式仕様)**: Cloudflare の rollback ドキュメントに、「アクティブ deployment と rollback 先の間で DO migration が発生した場合 rollback できない」と明示されている (検証済み: https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)。`new_sqlite_classes` の追加であっても migration として扱われるため、当該デプロイより前への rollback は不可能。**migration を含むデプロイは慎重に検証し、問題が出た場合は新たな fix デプロイ (前方修正) で対応する**前提で運用する。本リスクは migration を一切含まない (v1 のみで以降変更しない) フェーズでは顕在化しない。
- **Vitest スコープ**: 本仕様の `vitest run` は **純粋ユニットテストのみ** を対象とする (満タン時刻計算、入力 parse、エラー判定など)。Hono ハンドラ・Durable Object・KV・alarm に依存するテストを書く場合は `@cloudflare/vitest-pool-workers` を別途導入する追加仕様が必要 (本書の範囲外、Phase 2 で別途設計)。
- **Discord Bot Token のローテーション**: OIDC が存在しないため、定期的なローテーションを推奨。`wrangler secret put` 後にローカル `.dev.vars` を更新して `bun run register-commands` で REST 認証もリフレッシュ。
- **lefthook の test が遅くなった場合**: `pre-push` へ降格、または `--no-verify` を使わず `pre-push` でのみ走らせる構成へ移行。
- **register-commands の失敗**: deploy 自体は Worker 起動済みの状態で完了する。コマンド登録だけ別途リトライ (上記 §13)。
- **SHA pin 更新の不確実性**: Dependabot による SHA pin 更新は構成によっては動作しないとの指摘あり (Codex round 1)。初回 PR で実地検証し、不可なら `pinact` / `frizbee` の CI ステップ追加か Renovate への切替えを検討。
- **`bunx` で未 pin 依存を引き込まない**: `bunx zizmor` / `bunx actionlint` のように npm 未公開かつ wrapper が薄いツールは PATH のバイナリで運用し、`bunx` 経由にしない (本仕様の §5)。devDependency として pin した `wrangler` / `biome` / `lefthook` / `commitlint` のような binary は `bunx` 経由でローカル node_modules から呼ばれる挙動で問題ない (Bun は local node_modules を先に解決する)。

### 実装時の置換チェックリスト (`scripts/check-pins.sh`)

実装に入る前に、本仕様内の以下プレースホルダを必ず実値に置換する。`scripts/check-pins.sh` を以下の最低 4 ルールで実装し、`bun run check-pins` を CI workflow の必須ステップに組み込む。**チェック対象は `docs/` を除外** (本 spec 自身は意図的にプレースホルダを含むドキュメントなので、scan の対象から外す):

1. `docs/` 以外のリポジトリ全体で `<SHA>` リテラルが残存しないこと
2. `docs/` 以外で `<.+_PIN>` 形式のプレースホルダが残存しないこと (`<BUN_VERSION_PIN>` / `<ACTIONLINT_VERSION_PIN>` / `<ZIZMOR_VERSION_PIN>` / 各種ライブラリ PIN を含む)
3. `docs/` 以外で `<APPLICATION_ID>` / `<PUBLIC_KEY>` / `<実装日 YYYY-MM-DD>` リテラルが残存しないこと
4. `.github/workflows/*.yml` 内のすべての `uses:` 行が完全な 40 文字 hex の SHA で書かれていること (`@v4` / `@main` / 短縮 SHA は許容しない)。本リポジトリでは `.yaml` 拡張子は使わず `.yml` に統一する (本仕様内の他箇所で `.{yml,yaml}` と書いてあれば実装時に `.yml` に統一)

実装イメージ (bash):

```sh
#!/usr/bin/env bash
set -euo pipefail
fail=0
scan() {
  # docs を除外して grep
  if git grep -nE "$1" -- ':!docs/'; then
    echo "✗ Placeholder found: $1"
    fail=1
  fi
}
scan '<SHA>'
scan '<[A-Z_]+_PIN>'
scan '<APPLICATION_ID>'
scan '<PUBLIC_KEY>'
scan '<実装日 YYYY-MM-DD>'
# uses 行の検査:
# - すべての `uses:` 行を最初に集める (`- uses:` list item 形式と `uses:` 形式の両方、`@` が無い行も含む)
# - ローカル action (`./` で始まる) は許容、それ以外は完全な 40-char hex の SHA pin が必須
# - `docker://` 等 GitHub Actions の SHA pin が成立しない参照は明示的に拒否
# - 0 件マッチでも set -e で落ちないよう `|| true` を付与
uses_lines=$(git grep -nE '^[[:space:]]*-?[[:space:]]*uses:[[:space:]]+\S+' \
  -- '.github/workflows/*.yml' '.github/workflows/*.yaml' || true)
bad_lines=$(echo "$uses_lines" | awk -F'uses:[[:space:]]+' '
  NF > 1 {
    ref = $2
    sub(/[[:space:]].*$/, "", ref)
    # ローカル action はスキップ
    if (ref ~ /^\.\.?\//) next
    # 完全な @<40hex> 終端でない remote action はエラー
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

対象プレースホルダ:

- `<BUN_VERSION_PIN>` (`package.json` の `packageManager` / `setup-bun` の `bun-version` / Workers Builds `BUN_VERSION` で同値)
- `<BIOME_PIN>`, `<COMMITLINT_PIN>`, `<WORKERS_TYPES_PIN>`, `<LEFTHOOK_PIN>`, `<TS_PIN>`, `<VITEST_PIN>`, `<WRANGLER_PIN>`, `<HONO_PIN>`, `<DISCORD_INTERACTIONS_PIN>`
- `<ACTIONLINT_VERSION_PIN>`, `<ZIZMOR_VERSION_PIN>` (action wrapper の `version` input、内包 binary を pin)
- `<SHA>` (`actions/checkout`, `oven-sh/setup-bun`, `raven-actions/actionlint`, `zizmorcore/zizmor-action`)
- `<APPLICATION_ID>` (`wrangler.toml [vars]`)
- `<PUBLIC_KEY>` (`wrangler.toml [vars]`、Ed25519 公開鍵)
- `<実装日 YYYY-MM-DD>` (`wrangler.toml` の `compatibility_date`)

すべての placeholder が解消されるまで `main` への merge を許可しない (branch protection の required status check が CI green を要求するため、`check-pins` が落ちる構成にすれば強制可能)。

---

## 15. 関連メモリ

- Discord 返信ではマークダウンテーブルを使わない (`memory/feedback_discord_no_tables.md`)

---

## 16. 実装アーティファクトの具体雛形

§12 step 9 で materialize すべきファイル群のうち、本仕様内に置いていなかった分の最低限の中身。実装時はこれを起点に調整する。

### 16.1 `tsconfig.json` (Cloudflare Workers + Hono)

```jsonc
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ESNext"],
    "types": ["@cloudflare/workers-types/2026-06-01"],
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

- `types` の `@cloudflare/workers-types/<date>` は `wrangler.toml` の `compatibility_date` と同じ日付を指定し、Worker ランタイムの型を厳密に揃える
- `noEmit: true` は wrangler 側がバンドルするため、tsc は型チェック専用 (`tsc --noEmit` で `bun run typecheck` の用途)
- 厳格寄りオプション (`noUncheckedIndexedAccess`, `noUnusedLocals` 等) を有効化、Biome の lint と二段で品質担保

### 16.2 `biome.json` (Biome 1 本でフォーマッタ + リンタ)

```jsonc
{
  "$schema": "https://biomejs.dev/schemas/<BIOME_PIN>/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  },
  "organizeImports": { "enabled": true },
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

- `useIgnoreFile: true` で `.gitignore` の除外パターンをそのまま採用
- `quoteStyle: "single"` / `semicolons: "always"` / `trailingCommas: "all"` は CLAUDE.md の規約 (Conventional Commits + 一般的な TS スタイル) と整合
- ルールセットは Biome の `recommended` を起点に、`noExplicitAny` と `noNonNullAssertion` を warn に明示 (CI で fail させたければ後で error に格上げ)

### 16.3 `vitest.config.ts` (純粋ユニットスコープ)

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node', // Worker/DO/KV は対象外、純粋関数 / parser / 計算ロジックのみ
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

- 本仕様 §14 のとおり、Worker / DO / KV / alarm を含む integration test は対象外。`@cloudflare/vitest-pool-workers` の導入は Phase 2 の別仕様
- `coverage` は `src/durable-objects/**` を除外 (DO 内は別途 miniflare 系で検証する想定)
- `passWithNoTests: false` で「テストファイルが 1 つもない」状態を CI fail にし、テスト導入を放置しない

### 16.4 `.gitignore`

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

- **`bun.lock` は git に commit する** (§4 の再現性方針)。`.gitignore` に書かないこと
- `.dev.vars*` と `.env*` の両方をパターン除外し、環境別 (例: `.dev.vars.production`) のローカル secret も漏らさない
- `.wrangler/` は `wrangler dev` のローカル D1/KV エミュレーション state を含む、必ず除外

### 16.5 README.md の扱い

本リポジトリでは独立の `README.md` を作らず、**`HANDOFF.md` がリポジトリのフロントページを兼ねる**。GitHub では `HANDOFF.md` を Repository description から誘導する。理由:

- 個人開発で受け手が単一、HANDOFF.md にプロジェクト概要 / 次にやること / 関連文書 がすべて集約されており重複を避けたい
- 将来 README が必要になった場合 (公開 / コラボレーター追加など) は `HANDOFF.md` を要約した薄い README を別途追加する

GitHub UI の「README を作って」プロンプトは無視する。

### 16.6 初回 commit メッセージ規約

- すべての commit が `commitlint.config.ts` (Conventional Commits + scope 禁止) を通る必要がある
- 初回の空 commit や setup commit は **`chore: initialize repository`** とする (type: chore、subject case 任意、scope なし)
- 以降の commit 例:
  - `feat: add stamina add handler`
  - `fix: align register-commands path resolution`
  - `chore: pin bun 1.2.20`
  - `ci: add workflow_dispatch trigger`
  - `docs: sync architecture.md to spec round 13`

### 16.7 `package.json` の `trustedDependencies` (空配列で開始)

§14 で `--ignore-scripts` 方針を採用、依存の install script は default で動かない。本リポジトリでは **`trustedDependencies` は空配列**で初期化し、必要が出た時のみ明示追加する:

```jsonc
{
  "trustedDependencies": []
}
```

将来「特定の依存パッケージの install script を信頼して動かす」必要が出たら、ここにパッケージ名を明示してから `bun install --trust` で個別解除する。

---
